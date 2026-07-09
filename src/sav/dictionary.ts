import type { Cursor } from "./binary";
import type { RawVariable } from "./variable";

import { SavError } from "../limits";
import { readVariableRecord } from "./variable";

// A dictionary record is at least the 4-byte rec_type, so a well-formed file never approaches this;
// the backstop only fires on a hostile stream that never reaches the type-999 terminator.
const MAX_DICT_RECORDS = 10_000_000;
// SPSS documents are a handful of 80-char lines; a negative or absurd count is a malformed record and
// (negative) would make `skip` — the one cursor primitive that can move backward — rewind the loop.
const MAX_DOC_LINES = 100_000;

export type RawValueLabel = { raw: Uint8Array; labelRaw: Uint8Array };
export type RawValueLabelSet = { labels: RawValueLabel[]; varIndexes: number[] };
export type RawExtension = { subtype: number; size: number; count: number; bytes: Uint8Array };

export type RawDict = {
  variables: RawVariable[];
  /** For each kept variable (same order as `variables`), its 1-based PHYSICAL dictionary position —
   * i.e. counting the type=-1 string-continuation records that `variables` drops. Type-4 value-label
   * variable indexes are physical, so labels must be matched against this, not the logical index. */
  physicalIndexes: number[];
  valueLabelSets: RawValueLabelSet[];
  extensions: RawExtension[];
};

type DictState = {
  variables: RawVariable[];
  physicalIndexes: number[];
  physicalPos: number; // 1-based position of the NEXT variable record (real or continuation)
  valueLabelSets: RawValueLabelSet[];
  extensions: RawExtension[];
  pending?: RawValueLabelSet;
};

// The file's true encoding isn't known until the extension records are parsed (Task 6). Variable
// names are ASCII, so this provisional UTF-8 decoder is enough here; value bytes AND label bytes are
// kept raw and decoded downstream with the real file encoding (reader.ts).
const PROVISIONAL = new TextDecoder("utf-8");

/** Read one type-3 value-label record: an i32 count then `count` × (8 raw value bytes + a u8 label
 * length + label bytes), each entry padded so `(1 + label_len)` rounds up to a multiple of 8. The
 * raw value AND label bytes are kept undecoded — the value's numeric-vs-string kind is resolved by
 * the owning variable, and both are decoded with the file encoding in reader.ts. */
function readValueLabelSet(cur: Cursor): RawValueLabelSet {
  const count = cur.readI32();
  const labels: RawValueLabel[] = [];
  for (let i = 0; i < count; i++) {
    const raw = cur.readBytes(8);
    const labelLen = cur.readBytes(1)[0];
    const labelRaw = cur.readBytes(labelLen);
    cur.skip((8 - ((1 + labelLen) % 8)) % 8);
    labels.push({ raw, labelRaw });
  }
  return { labels, varIndexes: [] };
}

/** Read one type-7 extension record's header (subtype, element size, count) and capture its
 * `size*count`-byte payload verbatim for Task 6 to interpret by subtype. */
function readExtension(cur: Cursor): RawExtension {
  const subtype = cur.readI32();
  const size = cur.readI32();
  const count = cur.readI32();
  return { subtype, size, count, bytes: cur.readBytes(size * count) };
}

function handleVariable(cur: Cursor, state: DictState): void {
  const physIdx = state.physicalPos;
  state.physicalPos += 1; // both real records and continuations advance the physical position
  const v = readVariableRecord(cur, PROVISIONAL);
  if (v !== "continuation") {
    state.variables.push(v);
    state.physicalIndexes.push(physIdx);
  }
}

function handleValueLabels(cur: Cursor, state: DictState): void {
  state.pending = readValueLabelSet(cur);
  state.valueLabelSets.push(state.pending);
}

/** Type-4 record: an i32 count of 1-based variable indexes, attached to the preceding type-3 set. */
function handleVarIndexes(cur: Cursor, state: DictState): void {
  const count = cur.readI32();
  const idx: number[] = [];
  for (let i = 0; i < count; i++) idx.push(cur.readI32());
  if (state.pending) state.pending.varIndexes = idx;
}

/** Type-6 document record: an i32 line count then `n_lines` × 80 bytes we discard. */
function handleDocument(cur: Cursor): void {
  const nLines = cur.readI32();
  if (nLines < 0 || nLines > MAX_DOC_LINES) throw new SavError("invalid document record");
  cur.skip(nLines * 80);
}

function handleExtension(cur: Cursor, state: DictState): void {
  state.extensions.push(readExtension(cur));
}

const HANDLERS: Record<number, (cur: Cursor, state: DictState) => void> = {
  2: handleVariable,
  3: handleValueLabels,
  4: handleVarIndexes,
  6: handleDocument,
  7: handleExtension,
};

/** Walk the SPSS dictionary from the cursor's position (byte 176) until the type-999 terminator,
 * collecting variables in order, value-label sets (each type-3 record plus its trailing type-4
 * index record), and raw type-7 extension records for Task 6; type-6 document records are skipped. */
export function readDictionary(cur: Cursor): RawDict {
  const state: DictState = {
    variables: [],
    physicalIndexes: [],
    physicalPos: 1,
    valueLabelSets: [],
    extensions: [],
  };
  for (let records = 0; ; records++) {
    if (records > MAX_DICT_RECORDS) throw new SavError("too many dictionary records");
    const prev = cur.pos; // net cursor progress per record is the monotonic-advance guard below
    const recType = cur.readI32();
    if (recType === 999) {
      cur.readI32(); // terminator filler
      break;
    }
    const handler = HANDLERS[recType];
    if (!handler) throw new Error(`Unknown SPSS dictionary record type: ${recType}`);
    handler(cur, state);
    // A handler that left the cursor at or behind where the record began (e.g. a backward `skip`)
    // would spin the loop forever — reject the malformed record instead.
    if (cur.pos <= prev) throw new SavError("dictionary made no progress");
  }
  return {
    variables: state.variables,
    physicalIndexes: state.physicalIndexes,
    valueLabelSets: state.valueLabelSets,
    extensions: state.extensions,
  };
}

import type { Measure } from "../types";
import type { RawDict, RawExtension } from "./dictionary";

/** The subset of the SPSS dictionary recovered from the type-7 extension records: the true text
 * encoding, the system-missing sentinel, the short→long variable-name map, the short→char-width map
 * for very-long strings, and the per-variable measurement level (positional, dictionary order). */
export type DictInfo = {
  encoding: string;
  sysmis: number;
  longNames: Map<string, string>;
  veryLong: Map<string, number>;
  measures: Measure[];
};

// Every extension payload we read here is ASCII/UTF-8 (charset names, `SHORT=LongName` tokens). The
// file's declared charset (subtype 20) is only READ as a name — never used to decode data yet.
const UTF8 = new TextDecoder("utf-8");

/** Wrap a record payload in an endian-aware DataView (the ints/floats use the file's byte order). */
function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Split `bytes` into `KEY=VALUE` tokens and hand each key/value to `apply`; empty/keyless skipped. */
function eachPair(tokens: string[], apply: (key: string, value: string) => void): void {
  for (const token of tokens) {
    const eq = token.indexOf("=");
    if (eq > 0) apply(token.slice(0, eq), token.slice(eq + 1));
  }
}

/** Subtype 13: tab-separated `SHORT=LongName` pairs. */
function parseLongNames(bytes: Uint8Array, out: Map<string, string>): void {
  eachPair(UTF8.decode(bytes).split("\t"), (key, value) => out.set(key, value));
}

/** Subtype 14: `SHORT=width` pairs delimited by NUL and/or tab. */
function parseVeryLong(bytes: Uint8Array, out: Map<string, number>): void {
  const tokens = UTF8.decode(bytes)
    .split("\0")
    .flatMap((chunk) => chunk.split("\t"));
  eachPair(tokens, (key, value) => out.set(key, Number(value)));
}

function measureName(code: number): Measure {
  if (code === 1) return "nominal";
  if (code === 2) return "ordinal";
  if (code === 3) return "scale";
  return "unknown";
}

/** Subtype 11: `count/3` × (measure, width, alignment) i32 triples — keep the measure of each. The
 * triples are one per REAL variable record (they skip type=-1 continuations but DO include very-long
 * string segment sub-vars), so positional indexing against `raw.variables` aligns — verified in
 * Task 9 against the longstring + wide fixtures; the value-label physical-index remap (reader.ts) is
 * NOT applied here. */
function parseMeasures(record: RawExtension, little: boolean): Measure[] {
  const view = viewOf(record.bytes);
  const measures: Measure[] = [];
  const triples = Math.floor(record.count / 3);
  for (let t = 0; t < triples; t++) {
    // A well-formed subtype-11 has size=4, so `bytes` holds 12 per triple; a hostile size<4 shrinks
    // `bytes` below the count-derived triple stride, so stop before getInt32 reads past the payload.
    if (t * 12 + 12 > record.bytes.length) break;
    measures.push(measureName(view.getInt32(t * 12, little)));
  }
  return measures;
}

function applyRecord(record: RawExtension, little: boolean, info: DictInfo): void {
  switch (record.subtype) {
    case 20: // character encoding: the whole payload is the charset name
      info.encoding = UTF8.decode(record.bytes).trim();
      break;
    case 4: // machine floating-point info: sysmis, highest, lowest — keep sysmis
      info.sysmis = viewOf(record.bytes).getFloat64(0, little);
      break;
    case 13:
      parseLongNames(record.bytes, info.longNames);
      break;
    case 14:
      parseVeryLong(record.bytes, info.veryLong);
      break;
    case 11:
      info.measures = parseMeasures(record, little);
      break;
    default: // 3/17/18/21/22 and any unknown subtype: enrichments handled later, or unneeded
      break;
  }
}

/** Interpret the captured type-7 extension records into a `DictInfo`, reading each record's ints and
 * floats with the file's byte order (`little`). Unhandled subtypes are ignored, never thrown. */
export function applyExtensions(raw: RawDict, little: boolean): DictInfo {
  const info: DictInfo = {
    encoding: "utf-8",
    sysmis: -Number.MAX_VALUE,
    longNames: new Map(),
    veryLong: new Map(),
    measures: [],
  };
  for (const record of raw.extensions) applyRecord(record, little, info);
  return info;
}

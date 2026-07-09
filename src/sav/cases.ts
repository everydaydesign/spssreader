import type { SavLimits } from "../limits";
import type { CellValue, Variable } from "../types";
import type { DictInfo } from "./extensions";
import type { SavHeader } from "./header";
import type { ValueSource } from "./source";

import { SavError } from "../limits";
import { spssToDate } from "./dates";

/** A variable paired with the physical segment layout the case reader needs. `segments` holds the
 * allocated byte widths of the string segments to read and concatenate — one entry for a normal
 * string (≤ 255), N entries for a very-long string reassembled from N segments; empty for numerics. */
export type VariablePlan = {
  variable: Variable;
  segments: number[];
};

/** Map the file's declared charset name onto the three TextDecoder labels Bun's types accept
 * (`Bun.Encoding`): a plain `string` isn't assignable, so collapse it here without an `as` cast.
 * (The three-way mapping is validated by Task 9's encoding fixtures.) */
export function toBunEncoding(enc: string): "utf-8" | "windows-1252" | "utf-16" {
  const e = enc.toLowerCase();
  if (e.includes("1252") || e.includes("ansi") || e.includes("8859") || e.includes("latin")) {
    return "windows-1252";
  }
  if (e.includes("16")) return "utf-16";
  return "utf-8";
}

/** Read one string segment: `ceil(alloc/8)` 8-byte chunks, keeping only the segment's first `alloc`
 * content bytes. The chunk padding past `alloc` is inter-segment filler (a partial trailing 8-byte
 * unit) that must NOT survive into the concatenation of a very-long string's segments. */
function readSegment(alloc: number, source: ValueSource): Uint8Array {
  const chunks = Math.max(1, Math.ceil(alloc / 8));
  const raw = new Uint8Array(chunks * 8);
  for (let c = 0; c < chunks; c++) raw.set(source.nextString8(), c * 8);
  return raw.subarray(0, alloc);
}

/** A string cell is one or more segments concatenated at the BYTE level (very-long strings span
 * several), decoded once with the file encoding (so a multi-byte char split across a segment
 * boundary survives), then stripped of SPSS's trailing-space padding. */
function readStringValue(segments: number[], source: ValueSource, dec: TextDecoder): string {
  const parts: Uint8Array[] = [];
  for (const alloc of segments) parts.push(readSegment(alloc, source));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const all = new Uint8Array(total);
  let ofs = 0;
  for (const p of parts) {
    all.set(p, ofs);
    ofs += p.length;
  }
  return dec.decode(all).replace(/ +$/, "");
}

/** A numeric cell is one f64; system-missing stays `null`, a date format maps its seconds to a Date. */
function readNumericCell(variable: Variable, source: ValueSource): CellValue {
  const v = source.nextNumeric();
  if (v !== null && variable.format.isDate) return spssToDate(v);
  return v;
}

function readCell(plan: VariablePlan, source: ValueSource, dec: TextDecoder): CellValue {
  if (plan.segments.length > 0) return readStringValue(plan.segments, source, dec);
  return readNumericCell(plan.variable, source);
}

/** Read the flat data section into rows, one cell per plan in dictionary order. When the header
 * carries a real case count (`ncases >= 0`) exactly that many rows are read; when it is unknown
 * (`ncases = -1`, which real SPSS writes — e.g. the user's GenAI.sav — even though haven never does)
 * rows are read until the source reaches the end-of-data marker. */
export function readCases(
  header: SavHeader,
  plans: VariablePlan[],
  dictInfo: DictInfo,
  source: ValueSource,
  limits: SavLimits,
): CellValue[][] {
  const dec = new TextDecoder(toBunEncoding(dictInfo.encoding));
  const rows: CellValue[][] = [];
  if (header.ncases >= 0) {
    // Bounded upfront by readSav's `ncases × nvars ≤ maxCells` check before we get here.
    for (let i = 0; i < header.ncases; i++) {
      rows.push(plans.map((plan) => readCell(plan, source, dec)));
    }
    return rows;
  }
  while (!source.atEnd()) {
    rows.push(plans.map((plan) => readCell(plan, source, dec)));
    // The unknown-count path has no header ceiling — cap materialized cells so a crafted
    // never-ending stream can't grow `rows` without bound.
    if (rows.length * plans.length > limits.maxCells) {
      throw new SavError("case count exceeds cell limit");
    }
  }
  return rows;
}

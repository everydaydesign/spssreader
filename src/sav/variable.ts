import type { MissingSpec, SpssFormat } from "../types";
import type { Cursor } from "./binary";

import { SavError } from "../limits";

// The only n_missing_values SPSS emits: 0 none · 1..3 discrete · -2 range · -3 range+one discrete.
// Anything else (a bogus 1000, or Math.abs(-2147483648) staying hugely negative) would drive
// readMissing to read count-many slots past the buffer, so it is rejected outright.
const VALID_NMISSING = new Set([-3, -2, 0, 1, 2, 3]);

export type RawVariable = {
  name: string;
  type: number;
  label?: string;
  missing: MissingSpec;
  print: SpssFormat;
  write: SpssFormat;
};

/** Unpack SPSS's 3-byte format code: byte0 decimals, byte1 width, byte2 type. `isDate` stays a
 * defaulted pure predicate so this module needs no forward dep on date detection (wired in Task 8). */
export function decodeFormat(
  packed: number,
  isDate: (t: number) => boolean = () => false,
): SpssFormat {
  const decimals = packed & 0xff;
  const width = (packed >> 8) & 0xff;
  const type = (packed >> 16) & 0xff;
  return { type, width, decimals, isDate: isDate(type) };
}

/** Map n_missing_values to a MissingSpec: 0 none · >0 discrete · -2 range · -3 range+one discrete. */
export function decodeMissing(n: number, values: number[]): MissingSpec {
  if (n === 0) return { kind: "none" };
  if (n > 0) return { kind: "discrete", values };
  if (n === -2) return { kind: "range", lo: values[0], hi: values[1] };
  return { kind: "range+discrete", lo: values[0], hi: values[1], value: values[2] };
}

/** Read a variable's `|n_missing|` trailing missing-value slots. A string variable (width > 0) stores
 * each as an 8-byte right-space-padded string; a numeric variable stores each as an f64 (and negative
 * counts select range / range+discrete). String missing counts are always positive (no ranges).
 * String slots are decoded with `dec` (the dictionary-time provisional decoder — ASCII-safe for the
 * short sentinels SPSS allows here; a non-ASCII string sentinel would need the file encoding). */
function readMissing(cur: Cursor, nMissing: number, type: number, dec: TextDecoder): MissingSpec {
  const count = Math.abs(nMissing);
  if (type > 0) {
    const values: string[] = [];
    for (let i = 0; i < count; i++) values.push(cur.readStr(8, dec).replace(/ +$/, ""));
    return count > 0 ? { kind: "strings", values } : { kind: "none" };
  }
  const nums: number[] = [];
  for (let i = 0; i < count; i++) nums.push(cur.readF64());
  return decodeMissing(nMissing, nums);
}

/** Read one type-2 variable record. The cursor starts at the `type` field (the leading rec_type=2
 * int is consumed by the dictionary loop). Returns `"continuation"` for a long-string overflow
 * segment (type === -1): its body (has_label, n_missing, print, write, name — all zero/blank per
 * spec) still occupies the fixed 24 trailing bytes, which MUST be consumed or the loop desyncs. */
export function readVariableRecord(cur: Cursor, dec: TextDecoder): RawVariable | "continuation" {
  const type = cur.readI32();
  if (type === -1) {
    cur.skip(24); // has_label(4) + n_missing(4) + print(4) + write(4) + name(8), all ignored
    return "continuation";
  }
  const hasLabel = cur.readI32();
  const nMissing = cur.readI32();
  if (!VALID_NMISSING.has(nMissing)) throw new SavError("invalid missing-value count");
  const print = decodeFormat(cur.readI32());
  const write = decodeFormat(cur.readI32());
  const name = cur.readStr(8, dec).replace(/[\s\0]+$/, ""); // SPSS pads short names with NUL or space
  let label: string | undefined;
  if (hasLabel) {
    const labelLen = cur.readI32();
    label = cur.readStr(labelLen, dec);
    cur.skip((4 - (labelLen % 4)) % 4);
  }
  const missing = readMissing(cur, nMissing, type, dec);
  return { name, type, label, missing, print, write };
}

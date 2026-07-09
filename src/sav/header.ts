import type { Cursor } from "./binary";

import { SavError } from "../limits";

export type SavHeader = {
  zlib: boolean;
  compression: 0 | 1 | 2;
  bias: number;
  ncases: number;
  fileLabel: string;
};

// "windows-1252" is the WHATWG decoder that "ascii" aliases to; Bun.Encoding lacks the "ascii" label.
const ASCII = new TextDecoder("windows-1252");

function asCompression(v: number): 0 | 1 | 2 {
  if (v === 0 || v === 1 || v === 2) return v;
  throw new Error(`Unsupported SPSS compression flag: ${v}`);
}

/** Read the 176-byte file header. Detects byte order from layout_code (must read as 2 or 3), sets
 * `cur.little`, and leaves the cursor at byte 176 (start of the dictionary). */
export function readHeader(cur: Cursor): SavHeader {
  // Every field below lives within the fixed 176-byte header; a shorter buffer would surface as a
  // raw RangeError from a DataView read, so reject it up front as a clean SavError.
  if (cur.length < 176) throw new SavError("file too small to be a .sav");
  const magic = cur.readStr(4, ASCII);
  if (magic !== "$FL2" && magic !== "$FL3") throw new Error("Not an SPSS system file (bad magic)");
  cur.little = cur.view.getInt32(64, true) === 2 || cur.view.getInt32(64, true) === 3;
  cur.seek(64);
  cur.readI32(); // layout_code
  cur.readI32(); // nominal_case_size (unreliable — recomputed from variables)
  const compression = asCompression(cur.readI32());
  cur.readI32(); // weight_index
  const ncases = cur.readI32();
  const bias = cur.readF64();
  cur.skip(9 + 8); // creation_date + creation_time
  const fileLabel = cur.readStr(64, ASCII).replace(/[\s\0]+$/, "");
  cur.skip(3); // padding → byte 176
  return { zlib: magic === "$FL3", compression, bias, ncases, fileLabel };
}

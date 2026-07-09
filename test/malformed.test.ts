import type { RawDict, RawExtension } from "../src/sav/dictionary.ts";

import { describe, expect, test } from "bun:test";

import { readSav, SavError } from "../src/index.ts";
import { Cursor } from "../src/sav/binary.ts";
import { readDictionary } from "../src/sav/dictionary.ts";
import { applyExtensions } from "../src/sav/extensions.ts";
import { readHeader } from "../src/sav/header.ts";
import { readVariableRecord } from "../src/sav/variable.ts";

// HT3 dictionary-loop robustness: every malformed field below (negative doc line count, out-of-spec
// missing-value count, sub-176-byte "file", sub-4 measures element size) must be rejected with a
// catchable SavError instead of a raw RangeError, a backward cursor skip, or an out-of-bounds read.

const DEC = new TextDecoder("utf-8");

function i32(n: number): number[] {
  const b = new ArrayBuffer(4);
  new DataView(b).setInt32(0, n, true);
  return [...new Uint8Array(b)];
}

function nameBytes(name: string): number[] {
  return [...new TextEncoder().encode(name.padEnd(8, " ").slice(0, 8))];
}

// A type-2 variable body WITHOUT the leading rec_type int (the dictionary loop consumes that).
function varBody(type: number, nMissing: number, name: string): ArrayBuffer {
  return new Uint8Array([
    ...i32(type),
    ...i32(0), // has_label
    ...i32(nMissing),
    ...i32(0), // print
    ...i32(0), // write
    ...nameBytes(name),
  ]).buffer;
}

describe("dictionary-loop robustness (HT3)", () => {
  test("type-6 document record with negative nLines throws SavError (M1)", () => {
    // Without the guard, cur.skip(-1 * 80) moves the cursor backward and the next readI32 lands out
    // of bounds → a raw RangeError; the guard rejects the negative line count as a SavError.
    const stream = new Uint8Array([...i32(6), ...i32(-1), ...i32(999), ...i32(0)]).buffer;
    expect(() => readDictionary(new Cursor(stream))).toThrow(SavError);
  });

  test("variable record with nMissing = 1000 throws SavError (M2)", () => {
    // Without the range check, readMissing would try to read 1000 f64 slots past the buffer.
    expect(() => readVariableRecord(new Cursor(varBody(0, 1000, "q")), DEC)).toThrow(SavError);
  });

  test("variable record with nMissing = -5 throws SavError (M2)", () => {
    expect(() => readVariableRecord(new Cursor(varBody(0, -5, "q")), DEC)).toThrow(SavError);
  });

  test("readHeader on a sub-176-byte $FL2 buffer throws SavError, not RangeError (L1)", () => {
    // A 4-byte "$FL2" passes the magic check but has no layout_code at offset 64 → getInt32(64)
    // would RangeError without the min-length guard.
    const buf = new Uint8Array([...new TextEncoder().encode("$FL2")]).buffer;
    expect(() => readHeader(new Cursor(buf))).toThrow(SavError);
  });

  test("readSav on a sub-176-byte buffer rejects with SavError (L1)", async () => {
    const buf = new Uint8Array([...new TextEncoder().encode("$FL2")]).buffer;
    await expect(readSav(buf)).rejects.toThrow(SavError);
  });

  test("subtype-11 measures record with size = 1 does not read past its bytes (M3)", () => {
    // count/3 = 10 triples claimed, but only 10 payload bytes exist: getInt32(t*12) would read OOB
    // (RangeError) for any t > 0 without the size guard. The guard stops before reading past bytes.
    const bad: RawExtension = { subtype: 11, size: 1, count: 30, bytes: new Uint8Array(10) };
    const raw: RawDict = {
      variables: [],
      physicalIndexes: [],
      valueLabelSets: [],
      extensions: [bad],
    };
    expect(() => applyExtensions(raw, true)).not.toThrow();
    expect(applyExtensions(raw, true).measures.length).toBeLessThan(Math.floor(30 / 3));
  });
});

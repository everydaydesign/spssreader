import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { DEFAULT_LIMITS, readSav, SavError } from "../src/index.ts";

// Adversarial resource-bound tests: a hostile `.sav` must be REJECTED with a `SavError` FAST — never
// OOM, never hang. Each crafted-byte test has a short per-test timeout so that a regression which
// re-opens an unbounded allocation/loop fails loudly (times out) instead of wedging the suite.
// A generous default budget means no well-formed file is affected — proven by basic.sav parsing.

const FAST = 2000; // ms; a bound throws effectively instantly, an unbounded read would exceed this
const BASIC_SAV = join(import.meta.dir, "../oracle/fixtures/basic.sav");

/** A 4-byte little-endian signed int, as a plain byte array for buffer assembly. */
function le32(n: number): number[] {
  const b = new ArrayBuffer(4);
  new DataView(b).setInt32(0, n, true);
  return [...new Uint8Array(b)];
}

/** 8 bytes of a right-space-padded SPSS short variable name. */
function nameBytes(name: string): number[] {
  return [...new TextEncoder().encode(name.padEnd(8, " ").slice(0, 8))];
}

/** A minimal valid 176-byte `.sav` header: `$FL2` magic, little-endian, given compression + ncases. */
function header176(ncases: number, compression = 0): number[] {
  const b = new ArrayBuffer(176);
  const dv = new DataView(b);
  new Uint8Array(b).set([...new TextEncoder().encode("$FL2")], 0);
  dv.setInt32(64, 2, true); // layout_code (byte-order probe → little-endian)
  dv.setInt32(68, 1, true); // nominal_case_size
  dv.setInt32(72, compression, true);
  dv.setInt32(80, ncases, true);
  dv.setFloat64(84, 100, true); // bias
  return [...new Uint8Array(b)];
}

/** A well-formed type-2 numeric variable record (no label, no missing). */
function numericVar(name = "v1"): number[] {
  return [
    ...le32(2), // rec_type
    ...le32(0), // type (numeric)
    ...le32(0), // has_label
    ...le32(0), // n_missing
    ...le32(0), // print
    ...le32(0), // write
    ...nameBytes(name),
  ];
}

/** The type-999 dictionary terminator + its filler int. */
function terminator(): number[] {
  return [...le32(999), ...le32(0)];
}

function toBuffer(parts: number[][]): ArrayBuffer {
  return new Uint8Array(parts.flat()).buffer;
}

describe("readSav resource bounds", () => {
  test(
    "ncases = 0x7FFFFFFF (1 var) rejects fast, never OOM",
    async () => {
      const bytes = toBuffer([header176(0x7fffffff), numericVar(), terminator()]);
      await expect(readSav(bytes)).rejects.toThrow(SavError);
    },
    FAST,
  );

  test(
    "variable record with labelLen = 0x7FFFFFFF rejects at the readBytes guard",
    async () => {
      // A type-2 record claiming a ~2 GiB label — the read must refuse to allocate past the file.
      const hugeLabelVar = [
        ...le32(2), // rec_type
        ...le32(0), // type
        ...le32(1), // has_label = 1
        ...le32(0), // n_missing
        ...le32(0), // print
        ...le32(0), // write
        ...nameBytes("v1"),
        ...le32(0x7fffffff), // label_len (huge)
      ];
      await expect(readSav(toBuffer([header176(1), hugeLabelVar]))).rejects.toThrow(SavError);
    },
    FAST,
  );

  test(
    "type-7 extension with huge size*count rejects at the readBytes guard",
    async () => {
      // rec_type 7, subtype 20, size 1, count 0x7FFFFFFF → a ~2 GiB payload claim.
      const hugeExt = [...le32(7), ...le32(20), ...le32(1), ...le32(0x7fffffff)];
      await expect(readSav(toBuffer([header176(1), hugeExt]))).rejects.toThrow(SavError);
    },
    FAST,
  );

  test(
    "file with no variables is rejected (empty-dict guard)",
    async () => {
      await expect(readSav(toBuffer([header176(0), terminator()]))).rejects.toThrow(SavError);
    },
    FAST,
  );

  test("a valid file with opts.maxCells below its size is rejected", async () => {
    const bytes = await Bun.file(BASIC_SAV).arrayBuffer();
    // basic.sav is 3 vars × 3 rows = 9 cells; a 1-cell budget must reject it.
    await expect(readSav(bytes, { maxCells: 1 })).rejects.toThrow(SavError);
  });

  test("a normal file still parses with default limits", async () => {
    const bytes = await Bun.file(BASIC_SAV).arrayBuffer();
    const parsed = await readSav(bytes);
    expect(parsed.sheets[0].variables.map((v) => v.name)).toEqual(["id", "score", "name"]);
    expect(parsed.sheets[0].rows.length).toBe(3);
    // opts merge over defaults, not replace: a high override still parses.
    const withOpts = await readSav(bytes, { maxCells: DEFAULT_LIMITS.maxCells });
    expect(withOpts.sheets[0].rows.length).toBe(3);
  });
});

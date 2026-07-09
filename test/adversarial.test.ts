import { describe, expect, test } from "bun:test";

import { readSav, SavError } from "../src/index.ts";

// HT4 acceptance gate: the END-TO-END adversarial fuzz suite. Each audit vector is exercised through
// the PUBLIC `readSav(arrayBuffer)` on a crafted hostile `.sav`, asserting it REJECTS with a catchable
// `SavError` FAST — never OOM, never hang, never a raw RangeError. Every test carries a short per-test
// timeout so a regression that re-opens an unbounded allocation/loop/inflate fails LOUDLY (times out)
// instead of wedging the suite. The prior unit tests (limits/malformed/source) prove the same guards
// in isolation; this file is the consolidated integration gate through the one public entry point.

const FAST = 3000; // ms; a bound throws effectively instantly, an unbounded read/inflate would exceed this

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

/** A minimal valid 176-byte `.sav` header: given magic (`$FL2` plain / `$FL3` ZSAV), little-endian
 * byte order, compression flag, and case count. */
function header176(magic: "$FL2" | "$FL3", compression: number, ncases: number): number[] {
  const b = new ArrayBuffer(176);
  const dv = new DataView(b);
  new Uint8Array(b).set([...new TextEncoder().encode(magic)], 0);
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

/** Deflate `bytes` through the platform CompressionStream (the inverse of the reader's inflate). */
async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate");
  const ab = await new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer();
  return new Uint8Array(ab);
}

/** Craft a full `$FL3` ZSAV file: a valid header + one numeric variable + terminator, then a
 * single-block ZSAV data section (ZHEADER 3×i64 + the deflate stream + a ZTRAILER head + 1
 * descriptor). All ZHEADER/ZTRAILER offsets are ABSOLUTE file offsets, so the dictionary prefix
 * length (`base`) is baked into every offset field. Returns the buffer and `base` for patching. */
async function craftZsavFile(
  block: Uint8Array,
  ncases: number,
): Promise<{ buf: ArrayBuffer; base: number }> {
  const prefix = new Uint8Array([header176("$FL3", 2, ncases), numericVar(), terminator()].flat());
  const base = prefix.length;
  const compressed = await deflate(block);
  const ZHEADER = 24; // 3 × i64
  const trailerLocal = ZHEADER + compressed.length;
  const trailerLen = 24 + 24; // head (bias, zero, block_size, n_blocks) + 1 descriptor
  const section = new ArrayBuffer(trailerLocal + trailerLen);
  const dv = new DataView(section);
  new Uint8Array(section).set(compressed, ZHEADER);
  dv.setBigInt64(0, BigInt(base), true); // zheader_ofs (ignored by the reader)
  dv.setBigInt64(8, BigInt(base + trailerLocal), true); // ztrailer_ofs (absolute)
  dv.setBigInt64(16, BigInt(trailerLen), true); // ztrailer_len
  dv.setBigInt64(trailerLocal, 0n, true); // bias
  dv.setBigInt64(trailerLocal + 8, 0n, true); // zero
  dv.setInt32(trailerLocal + 16, 0, true); // block_size
  dv.setInt32(trailerLocal + 20, 1, true); // n_blocks
  dv.setBigInt64(trailerLocal + 24, 0n, true); // uncompressed_ofs
  dv.setBigInt64(trailerLocal + 32, BigInt(base + ZHEADER), true); // compressed_ofs (absolute)
  dv.setInt32(trailerLocal + 40, block.length, true); // uncompressed_size
  dv.setInt32(trailerLocal + 44, compressed.length, true); // compressed_size
  const buf = new Uint8Array(base + section.byteLength);
  buf.set(prefix, 0);
  buf.set(new Uint8Array(section), base);
  return { buf: buf.buffer, base };
}

describe("adversarial fuzz gate — every hostile .sav rejected with SavError (HT4)", () => {
  test(
    "C1 — ZSAV decompression bomb: a block inflating past maxInflatedBytes rejects fast",
    async () => {
      // 8 MiB of zeros deflates to a few KB; a 1 MiB inflate budget must abort mid-stream (never
      // materialize the full 8 MiB) instead of ballooning past the ceiling.
      const { buf } = await craftZsavFile(new Uint8Array(8 * 1024 * 1024), 1);
      await expect(readSav(buf, { maxInflatedBytes: 1024 * 1024 })).rejects.toThrow(SavError);
    },
    FAST,
  );

  test(
    "C2 — huge ncases (0x7FFFFFFF × 1 var, RLE) rejects at the cell budget, never OOM",
    async () => {
      const buf = toBuffer([header176("$FL2", 1, 0x7fffffff), numericVar(), terminator()]);
      await expect(readSav(buf)).rejects.toThrow(SavError);
    },
    FAST,
  );

  test(
    "H1 — empty dictionary with ncases = -1 rejects (no variables → unbounded-row loop guard)",
    async () => {
      // ncases = -1 is the unknown-count path; with zero variables each row consumes zero cells so
      // the loop could never advance — the empty-dict guard rejects it before the loop starts.
      const buf = toBuffer([header176("$FL2", 1, -1), terminator()]);
      await expect(readSav(buf)).rejects.toThrow(SavError);
    },
    FAST,
  );

  test(
    "H2 — type-7 extension with huge size*count rejects at the readBytes guard",
    async () => {
      // rec_type 7, subtype 20, size 1, count 0x7FFFFFFF → a ~2 GiB payload claim.
      const hugeExt = [...le32(7), ...le32(20), ...le32(1), ...le32(0x7fffffff)];
      await expect(readSav(toBuffer([header176("$FL2", 1, 1), hugeExt]))).rejects.toThrow(SavError);
    },
    FAST,
  );

  test(
    "H3 — variable record with huge labelLen rejects at the readBytes guard",
    async () => {
      const hugeLabelVar = [
        ...le32(2), // rec_type
        ...le32(0), // type
        ...le32(1), // has_label = 1
        ...le32(0), // n_missing
        ...le32(0), // print
        ...le32(0), // write
        ...nameBytes("v1"),
        ...le32(0x7fffffff), // label_len (~2 GiB)
      ];
      await expect(readSav(toBuffer([header176("$FL2", 1, 1), hugeLabelVar]))).rejects.toThrow(
        SavError,
      );
    },
    FAST,
  );

  test(
    "H4 — ZSAV with huge nBlocks rejects at the block-count sanity cap",
    async () => {
      const { buf, base } = await craftZsavFile(new Uint8Array([1, 2, 3]), 1);
      // Patch n_blocks past the sanity cap; ztrailer_ofs (absolute) lives at ZHEADER+8.
      const trailerOfs = Number(new DataView(buf).getBigInt64(base + 8, true));
      new DataView(buf).setInt32(trailerOfs + 20, 2_000_000, true);
      await expect(readSav(buf)).rejects.toThrow(SavError);
    },
    FAST,
  );

  test(
    "M1 — type-6 document record with negative nLines rejects (no backward skip)",
    async () => {
      // Without the guard, cur.skip(-1 × 80) rewinds the cursor and spins the dictionary loop.
      const negDoc = [...le32(6), ...le32(-1)];
      await expect(readSav(toBuffer([header176("$FL2", 1, 1), negDoc]))).rejects.toThrow(SavError);
    },
    FAST,
  );

  test(
    "M2 — variable record with out-of-spec nMissing (1000) rejects",
    async () => {
      // n_missing must be one of {-3,-2,0,1,2,3}; a bogus 1000 would read 1000 f64 slots past EOF.
      const badMissingVar = [
        ...le32(2), // rec_type
        ...le32(0), // type
        ...le32(0), // has_label
        ...le32(1000), // n_missing (out of spec)
        ...le32(0), // print
        ...le32(0), // write
        ...nameBytes("v1"),
      ];
      await expect(readSav(toBuffer([header176("$FL2", 1, 1), badMissingVar]))).rejects.toThrow(
        SavError,
      );
    },
    FAST,
  );

  test(
    "M3 — subtype-11 measures with size < 4 stays bounded (no OOB RangeError)",
    async () => {
      // A well-formed subtype-11 has size=4 (12 bytes/triple); this hostile size=1, count=30 claims
      // 10 triples over only 30 payload bytes. Without the size guard, getInt32 would read past the
      // payload (a raw RangeError). Per HT3's lenient contract this is bounded, not necessarily
      // rejected: readSav either parses (guard broke the loop before OOB) or throws a catchable
      // SavError — but NEVER a raw RangeError.
      const measuresExt = [
        ...le32(7),
        ...le32(11),
        ...le32(1),
        ...le32(30),
        ...new Array(30).fill(0),
      ];
      const buf = toBuffer([header176("$FL2", 0, 0), numericVar(), measuresExt, terminator()]);
      const result = await readSav(buf).catch((e: unknown) => {
        expect(e).toBeInstanceOf(SavError);
        return null;
      });
      if (result !== null) expect(result.sheets[0].variables).toHaveLength(1);
    },
    FAST,
  );

  test(
    "L1 — truncated (<176-byte) file rejects with SavError, not a raw RangeError",
    async () => {
      // A short "$FL2" buffer passes the magic check but has no layout_code at offset 64.
      const truncated = new Uint8Array(64);
      truncated.set([...new TextEncoder().encode("$FL2")], 0);
      await expect(readSav(truncated.buffer)).rejects.toThrow(SavError);
    },
    FAST,
  );
});

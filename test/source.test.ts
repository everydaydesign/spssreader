import { describe, expect, test } from "bun:test";

import type { SavHeader } from "../src/sav/header.ts";
import { SavError } from "../src/limits.ts";
import { Cursor } from "../src/sav/binary.ts";
import { inflateZsav, makeSource } from "../src/sav/source.ts";

const SYSMIS = -Number.MAX_VALUE;
const GENEROUS = 512 * 1024 * 1024; // well above every crafted block

function header(compression: 0 | 1 | 2, bias = 100): SavHeader {
  return { zlib: false, compression, bias, ncases: 0, fileLabel: "" };
}

async function deflate(bytes: Uint8Array): Promise<ArrayBuffer> {
  const cs = new CompressionStream("deflate");
  return new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer();
}

/** Frame `blockBytes` (deflated) as a minimal single-block ZSAV: ZHEADER (3×i64) + the deflate
 * stream + a ZTRAILER (head + 1 descriptor). Used to exercise the streaming inflate budget. */
async function makeZsav(blockBytes: Uint8Array): Promise<ArrayBuffer> {
  const compressed = new Uint8Array(await deflate(blockBytes));
  const ZHEADER = 24;
  const blockOfs = ZHEADER;
  const trailer = ZHEADER + compressed.length;
  const trailerLen = 24 + 24; // head (bias,zero,block_size,n_blocks) + 1 descriptor
  const buf = new ArrayBuffer(trailer + trailerLen);
  const dv = new DataView(buf);
  new Uint8Array(buf).set(compressed, blockOfs);
  dv.setBigInt64(0, 0n, true); // zheader_ofs
  dv.setBigInt64(8, BigInt(trailer), true); // ztrailer_ofs
  dv.setBigInt64(16, BigInt(trailerLen), true); // ztrailer_len
  dv.setBigInt64(trailer, 0n, true); // bias
  dv.setBigInt64(trailer + 8, 0n, true); // zero
  dv.setInt32(trailer + 16, 0, true); // block_size
  dv.setInt32(trailer + 20, 1, true); // n_blocks
  dv.setBigInt64(trailer + 24, 0n, true); // uncompressed_ofs
  dv.setBigInt64(trailer + 32, BigInt(blockOfs), true); // compressed_ofs
  dv.setInt32(trailer + 40, blockBytes.length, true); // uncompressed_size
  dv.setInt32(trailer + 44, compressed.length, true); // compressed_size
  return buf;
}

describe("makeSource — RLE (compression 1)", () => {
  test("numeric: compressed value, sysmis, literal", () => {
    const b = new ArrayBuffer(16);
    const u8 = new Uint8Array(b);
    u8.set([105, 255, 253, 0, 0, 0, 0, 0], 0); // octet: 5, sysmis, literal-follows, pads
    new DataView(b).setFloat64(8, 42.5, true); // the 253 literal
    const s = makeSource(new Cursor(b), header(1), SYSMIS);
    expect(s.nextNumeric()).toBe(5); // 105 − bias(100)
    expect(s.nextNumeric()).toBe(null); // 255 → system-missing
    expect(s.nextNumeric()).toBe(42.5); // 253 → literal double
  });

  test("numeric: code 0 pads are skipped, 252 ends the data", () => {
    const b = new ArrayBuffer(8);
    new Uint8Array(b).set([0, 0, 200, 252, 0, 0, 0, 0], 0);
    const s = makeSource(new Cursor(b), header(1), SYSMIS);
    expect(s.nextNumeric()).toBe(100); // skips two 0 pads, 200 − 100
    expect(s.nextNumeric()).toBe(null); // 252 end-of-data
  });

  test("string: 8 spaces, then a literal 8 bytes", () => {
    const b = new ArrayBuffer(16);
    const u8 = new Uint8Array(b);
    u8.set([254, 253, 0, 0, 0, 0, 0, 0], 0); // octet: spaces, literal-follows, pads
    u8.set([65, 66, 67, 68, 69, 70, 71, 72], 8); // "ABCDEFGH" literal
    const s = makeSource(new Cursor(b), header(1), SYSMIS);
    expect([...s.nextString8()]).toEqual([32, 32, 32, 32, 32, 32, 32, 32]);
    expect([...s.nextString8()]).toEqual([65, 66, 67, 68, 69, 70, 71, 72]);
  });

  test("string: code 0 is octet padding (skipped), 254 → 8 spaces", () => {
    // 0 is a filler opcode that yields NO cell (like the numeric side) — it must be skipped, not
    // returned as data, or a string cell whose opcode sits past padding drifts. Proven by the
    // labels_order oracle fixture (a long string preceding a numeric, octet-padding between rows).
    const b = new ArrayBuffer(8);
    new Uint8Array(b).set([0, 254, 0, 0, 0, 0, 0, 0], 0);
    const s = makeSource(new Cursor(b), header(1), SYSMIS);
    expect([...s.nextString8()]).toEqual([32, 32, 32, 32, 32, 32, 32, 32]); // skips 0, 254 → spaces
  });

  test("octet refills after 8 codes", () => {
    const b = new ArrayBuffer(16);
    const u8 = new Uint8Array(b);
    u8.set([101, 102, 103, 104, 105, 106, 107, 108], 0); // octet 1: eight numerics
    u8.set([109, 252, 0, 0, 0, 0, 0, 0], 8); // octet 2: one more, then end
    const s = makeSource(new Cursor(b), header(1), SYSMIS);
    for (let i = 1; i <= 8; i++) expect(s.nextNumeric()).toBe(i); // 101..108 − 100
    expect(s.nextNumeric()).toBe(9); // 109 − 100 from the refilled octet
    expect(s.nextNumeric()).toBe(null); // 252
  });
});

describe("makeSource — uncompressed (compression 0)", () => {
  test("reads raw f64s and 8-byte strings; sysmis → null", () => {
    const b = new ArrayBuffer(24);
    const dv = new DataView(b);
    dv.setFloat64(0, 3.14, true);
    dv.setFloat64(8, SYSMIS, true); // system-missing sentinel
    new Uint8Array(b).set([1, 2, 3, 4, 5, 6, 7, 8], 16);
    const s = makeSource(new Cursor(b), header(0), SYSMIS);
    expect(s.nextNumeric()).toBe(3.14);
    expect(s.nextNumeric()).toBe(null);
    expect([...s.nextString8()]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe("inflateZsav", () => {
  test("DecompressionStream deflate round-trips (async plumbing)", async () => {
    const original = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    const compressed = new Uint8Array(await deflate(original));
    const ds = new DecompressionStream("deflate");
    const back = await new Response(new Blob([compressed]).stream().pipeThrough(ds)).arrayBuffer();
    expect([...new Uint8Array(back)]).toEqual([...original]);
  });

  test("reads the ZTRAILER and concatenates inflated blocks", async () => {
    const p1 = new Uint8Array([11, 22, 33]);
    const p2 = new Uint8Array([44, 55, 66, 77]);
    const c1 = new Uint8Array(await deflate(p1));
    const c2 = new Uint8Array(await deflate(p2));

    const ZHEADER = 24; // 3 × i64
    const block1 = ZHEADER;
    const block2 = ZHEADER + c1.length;
    const trailer = ZHEADER + c1.length + c2.length;
    const trailerLen = 24 + 2 * 24; // head (bias,zero,block_size,n_blocks) + 2 descriptors
    const buf = new ArrayBuffer(trailer + trailerLen);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);

    dv.setBigInt64(0, 0n, true); // zheader_ofs
    dv.setBigInt64(8, BigInt(trailer), true); // ztrailer_ofs
    dv.setBigInt64(16, BigInt(trailerLen), true); // ztrailer_len
    u8.set(c1, block1);
    u8.set(c2, block2);

    let t = trailer;
    dv.setBigInt64(t, 0n, true); // bias
    dv.setBigInt64(t + 8, 0n, true); // zero
    dv.setInt32(t + 16, 0, true); // block_size
    dv.setInt32(t + 20, 2, true); // n_blocks
    t += 24;
    const desc = (uncOfs: number, cmpOfs: number, uncLen: number, cmpLen: number): void => {
      dv.setBigInt64(t, BigInt(uncOfs), true);
      dv.setBigInt64(t + 8, BigInt(cmpOfs), true);
      dv.setInt32(t + 16, uncLen, true);
      dv.setInt32(t + 20, cmpLen, true);
      t += 24;
    };
    desc(0, block1, p1.length, c1.length);
    desc(p1.length, block2, p2.length, c2.length);

    const out = new Uint8Array(await inflateZsav(new Cursor(buf), GENEROUS));
    expect([...out]).toEqual([11, 22, 33, 44, 55, 66, 77]);
  });

  test("bomb: a block inflating past maxInflatedBytes throws SavError fast", async () => {
    // 10 MB of zeros deflates to a few KB; a 1 MB budget must abort mid-stream (never materialize
    // the full 10 MB) rather than let the inflated output balloon past the ceiling.
    const buf = await makeZsav(new Uint8Array(10 * 1024 * 1024));
    await expect(inflateZsav(new Cursor(buf), 1 * 1024 * 1024)).rejects.toThrow(SavError);
  });

  test("generous budget inflates the whole block", async () => {
    const zeros = new Uint8Array(10 * 1024 * 1024);
    const out = new Uint8Array(await inflateZsav(new Cursor(await makeZsav(zeros)), GENEROUS));
    expect(out.length).toBe(zeros.length);
  });

  test("nBlocks out of range throws SavError", async () => {
    const buf = await makeZsav(new Uint8Array([1, 2, 3]));
    const trailerOfs = Number(new DataView(buf).getBigInt64(8, true));
    new DataView(buf).setInt32(trailerOfs + 20, 2_000_000, true); // n_blocks past the sanity cap
    await expect(inflateZsav(new Cursor(buf), GENEROUS)).rejects.toThrow(SavError);
  });
});

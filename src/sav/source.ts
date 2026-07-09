import type { Cursor } from "./binary";
import type { SavHeader } from "./header";

import { SavError } from "../limits";

/** A compression-agnostic reader over a .sav data section: sequential numeric cells and 8-byte
 * string chunks. `nextNumeric` returns `null` for a system-missing (or end-of-data) value. */
export interface ValueSource {
  nextNumeric(): number | null;
  nextString8(): Uint8Array;
  /** True when the next cell boundary is the end-of-data marker (or the stream is exhausted) — the
   * termination signal a reader uses when the header's case count is unknown (`ncases = -1`). */
  atEnd(): boolean;
}

/** One ZSAV compressed block descriptor: where its deflate stream sits in the file and its length. */
type ZBlock = { compressedOfs: number; compressedSize: number };

/** A fresh 8-byte run filled with a single value (0x20 spaces or 0x00 NULs for string cells). */
function filled(byte: number): Uint8Array {
  return new Uint8Array(8).fill(byte);
}

/** Compression flag 0: numeric = raw f64 (equal to sysmis → null); string = raw 8 bytes. */
class UncompressedSource implements ValueSource {
  constructor(
    private readonly cur: Cursor,
    private readonly sysmis: number,
  ) {}

  nextNumeric(): number | null {
    const v = this.cur.readF64();
    return v === this.sysmis ? null : v;
  }

  nextString8(): Uint8Array {
    return this.cur.readBytes(8);
  }

  atEnd(): boolean {
    return this.cur.pos + 8 > this.cur.length; // no full 8-byte cell remains → data section done
  }
}

/** Compression flag 1 (and the inflated ZSAV stream): an 8-code control octet drives each cell.
 * Codes — 0 pad · 1..251 numeric `code − bias` · 252 end-of-data · 253 literal (the next 8 bytes
 * of the stream) · 254 eight spaces (strings) · 255 system-missing. Literals for a given octet
 * follow it in the stream, in code order, which is why we read them from the cursor as encountered. */
class RleSource implements ValueSource {
  private codes: Uint8Array = new Uint8Array(8);
  private idx = 8; // ≥ 8 forces an octet refill on the first pull
  private lookahead: number | null = null; // a control code peeked by atEnd(), not yet spent on a cell

  constructor(
    private readonly cur: Cursor,
    private readonly bias: number,
  ) {}

  /** Pull the next raw octet code. Synthesizes 252 (end-of-data) once the stream is exhausted, so an
   * unknown-case-count read (`ncases = -1`) terminates on atEnd() instead of over-reading past EOF. */
  private rawCode(): number {
    if (this.idx >= 8) {
      if (this.cur.pos >= this.cur.length) return 252;
      this.codes = this.cur.readBytes(8);
      this.idx = 0;
    }
    return this.codes[this.idx++];
  }

  /** Next cell-bearing control code: drains any peeked code, then skips 0 fillers (they encode no
   * cell — proven by the labels_order oracle fixture's inter-row octet padding). */
  private nextCode(): number {
    if (this.lookahead !== null) {
      const code = this.lookahead;
      this.lookahead = null;
      return code;
    }
    for (;;) {
      const code = this.rawCode();
      if (code !== 0) return code;
    }
  }

  atEnd(): boolean {
    if (this.lookahead === null) this.lookahead = this.nextCode();
    return this.lookahead === 252;
  }

  nextNumeric(): number | null {
    const code = this.nextCode();
    if (code === 252 || code === 255) return null; // end-of-data / system-missing
    if (code === 253) return this.cur.readF64(); // literal double follows the octet
    return code - this.bias;
  }

  nextString8(): Uint8Array {
    const code = this.nextCode();
    if (code === 254) return filled(0x20); // eight spaces
    if (code === 253) return this.cur.readBytes(8); // literal 8 bytes
    return filled(0x20); // 252 end-of-data / 255 / other → space-filled (SPSS pads strings with 0x20)
  }
}

/** Read a byte-order-aware 64-bit signed int; file offsets/lengths fit in a JS number. */
function readI64(cur: Cursor): number {
  const v = cur.view.getBigInt64(cur.pos, cur.little);
  cur.pos += 8;
  return Number(v);
}

/** Copy the parts into one contiguous ArrayBuffer sized to their total length. */
function concatToBuffer(parts: Uint8Array[]): ArrayBuffer {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new ArrayBuffer(total);
  const out = new Uint8Array(buf);
  let ofs = 0;
  for (const p of parts) {
    out.set(p, ofs);
    ofs += p.length;
  }
  return buf;
}

/** Inflate one zlib ("deflate") block through the platform DecompressionStream, streaming the output
 * chunk-by-chunk and aborting the moment it exceeds `maxBytes` — a few-KB block can inflate to
 * gigabytes (a decompression bomb), so we never materialize the whole output before checking. */
async function inflateDeflate(compressed: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  // Copy into a fresh ArrayBuffer-backed view: a generic Uint8Array<ArrayBufferLike> isn't a valid
  // BlobPart under the DOM lib (the consumer app typechecks this source).
  const bytes = new Uint8Array(compressed.length);
  bytes.set(compressed);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new SavError("ZSAV inflated output exceeds limit");
    }
    parts.push(value);
  }
  return new Uint8Array(concatToBuffer(parts));
}

/** Read the ZTRAILER at `ztrailerOfs` and return its per-block compressed descriptors. */
function readTrailerBlocks(cur: Cursor, ztrailerOfs: number): ZBlock[] {
  cur.seek(ztrailerOfs);
  readI64(cur); // bias
  readI64(cur); // zero
  cur.readI32(); // block_size
  const nBlocks = cur.readI32();
  if (nBlocks < 0 || nBlocks > 1_000_000) throw new SavError("ZSAV block count out of range");
  const blocks: ZBlock[] = [];
  for (let i = 0; i < nBlocks; i++) {
    readI64(cur); // uncompressed_ofs
    const compressedOfs = readI64(cur);
    cur.readI32(); // uncompressed_size
    blocks.push({ compressedOfs, compressedSize: cur.readI32() });
  }
  return blocks;
}

/** Pick the value source for a data section by its header compression flag. Flag 0 = raw f64/bytes;
 * flags 1 and 2 (2 = the already-inflated ZSAV stream) share the RLE control-octet decoding. */
export function makeSource(cur: Cursor, header: SavHeader, sysmis: number): ValueSource {
  if (header.compression === 0) return new UncompressedSource(cur, sysmis);
  return new RleSource(cur, header.bias);
}

/** Inflate a ZSAV ($FL3) data section into the RLE bytecode stream: read the ZHEADER offsets, walk
 * the ZTRAILER block descriptors, deflate-inflate each block, and concatenate. Offsets are absolute
 * file offsets, so `cur` must span the whole file.
 * Field framing (ZHEADER 3×i64; ZTRAILER bias/zero/block_size/n_blocks + per-block descriptors) and
 * the zlib-wrapped "deflate" (not "deflate-raw") stream are verified against the haven
 * `compress="zsav"` fixture in Task 9's oracle matrix. `maxInflatedBytes` caps the TOTAL inflated
 * output across all blocks (a streaming budget) so a decompression bomb throws instead of OOMing. */
export async function inflateZsav(cur: Cursor, maxInflatedBytes: number): Promise<ArrayBuffer> {
  readI64(cur); // zheader_ofs
  const ztrailerOfs = readI64(cur);
  readI64(cur); // ztrailer_len
  const blocks = readTrailerBlocks(cur, ztrailerOfs);
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const block of blocks) {
    cur.seek(block.compressedOfs);
    const inflated = await inflateDeflate(
      cur.readBytes(block.compressedSize),
      maxInflatedBytes - total,
    );
    total += inflated.length;
    parts.push(inflated);
  }
  return concatToBuffer(parts);
}

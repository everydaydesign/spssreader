import { SavError } from "../limits";

/** Endian-aware sequential reader over a DataView. `little` is set by the header's layout-code probe. */
export class Cursor {
  readonly view: DataView;
  pos = 0;
  little = true;

  constructor(buf: ArrayBuffer) {
    this.view = new DataView(buf);
  }

  get length(): number {
    return this.view.byteLength;
  }

  seek(p: number): void {
    this.pos = p;
  }

  skip(n: number): void {
    this.pos += n;
  }

  readI32(): number {
    const v = this.view.getInt32(this.pos, this.little);
    this.pos += 4;
    return v;
  }

  readF64(): number {
    const v = this.view.getFloat64(this.pos, this.little);
    this.pos += 8;
    return v;
  }

  readBytes(n: number): Uint8Array {
    // Bound every allocation to the bytes actually remaining: a hostile length field (`size*count`,
    // `labelLen`, `compressedSize`, …) can claim gigabytes, so refuse BEFORE `new Uint8Array(n)`.
    if (n < 0 || this.pos + n > this.length) {
      throw new SavError(`read of ${n} bytes exceeds the file`);
    }
    const out = new Uint8Array(n);
    out.set(new Uint8Array(this.view.buffer, this.view.byteOffset + this.pos, n));
    this.pos += n;
    return out;
  }

  readStr(n: number, dec: TextDecoder): string {
    return dec.decode(this.readBytes(n));
  }
}

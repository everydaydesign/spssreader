import { describe, expect, test } from "bun:test";
import { Cursor } from "../src/sav/binary.ts";

function buf(bytes: number[]): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

describe("Cursor", () => {
  test("reads little-endian i32 / f64 and advances", () => {
    // 1 as LE i32, then 2.0 as LE f64
    const b = new ArrayBuffer(12);
    const dv = new DataView(b);
    dv.setInt32(0, 1, true);
    dv.setFloat64(4, 2.0, true);
    const c = new Cursor(b);
    expect(c.readI32()).toBe(1);
    expect(c.readF64()).toBe(2.0);
    expect(c.pos).toBe(12);
  });

  test("honors big-endian when little=false", () => {
    const b = new ArrayBuffer(4);
    new DataView(b).setInt32(0, 258, false); // 0x00000102 big-endian
    const c = new Cursor(b);
    c.little = false;
    expect(c.readI32()).toBe(258);
  });

  test("readBytes copies and advances; skip/seek move position", () => {
    const c = new Cursor(buf([10, 20, 30, 40]));
    expect([...c.readBytes(2)]).toEqual([10, 20]);
    c.skip(1);
    expect(c.pos).toBe(3);
    c.seek(0);
    expect([...c.readBytes(1)]).toEqual([10]);
  });
});

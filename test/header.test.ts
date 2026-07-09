import { describe, expect, test } from "bun:test";
import { Cursor } from "../src/sav/binary.ts";
import { readHeader } from "../src/sav/header.ts";

function headerBytes(): ArrayBuffer {
  const b = new ArrayBuffer(176);
  const dv = new DataView(b);
  const u8 = new Uint8Array(b);
  u8.set([...new TextEncoder().encode("$FL2")], 0);
  dv.setInt32(64, 2, true); // layout_code
  dv.setInt32(68, 3, true); // nominal_case_size
  dv.setInt32(72, 1, true); // compression = RLE
  dv.setInt32(80, 3, true); // ncases
  dv.setFloat64(84, 100, true); // bias
  u8.set([...new TextEncoder().encode("hi")], 109); // file_label start
  return b;
}

describe("readHeader", () => {
  test("parses a little-endian $FL2 header and lands at byte 176", () => {
    const c = new Cursor(headerBytes());
    const h = readHeader(c);
    expect(h.zlib).toBe(false);
    expect(h.compression).toBe(1);
    expect(h.bias).toBe(100);
    expect(h.ncases).toBe(3);
    expect(h.fileLabel).toBe("hi");
    expect(c.pos).toBe(176);
    expect(c.little).toBe(true);
  });

  test("rejects a non-SPSS file", () => {
    expect(() => readHeader(new Cursor(new ArrayBuffer(176)))).toThrow(/SPSS/);
  });
});

import { describe, expect, test } from "bun:test";
import { Cursor } from "../src/sav/binary.ts";
import { readVariableRecord, decodeFormat, decodeMissing } from "../src/sav/variable.ts";

const DEC = new TextDecoder("utf-8");
// helper builds a type-2 body (WITHOUT the leading rec_type int, which the loop consumes)
function varBody(opts: {
  type: number;
  hasLabel?: boolean;
  label?: string;
  nMiss?: number;
  miss?: number[];
  print?: number;
  name: string;
}): ArrayBuffer {
  const parts: number[] = [];
  const dv = (n: number) => {
    const b = new ArrayBuffer(4);
    new DataView(b).setInt32(0, n, true);
    return [...new Uint8Array(b)];
  };
  parts.push(
    ...dv(opts.type),
    ...dv(opts.hasLabel ? 1 : 0),
    ...dv(opts.nMiss ?? 0),
    ...dv(opts.print ?? 0),
    ...dv(opts.print ?? 0),
  );
  const name = opts.name.padEnd(8, " ").slice(0, 8);
  parts.push(...new TextEncoder().encode(name));
  if (opts.hasLabel && opts.label !== undefined) {
    const enc = new TextEncoder().encode(opts.label);
    const padded = Math.ceil(enc.length / 4) * 4;
    parts.push(...dv(enc.length), ...enc, ...new Array(padded - enc.length).fill(0));
  }
  for (const m of opts.miss ?? []) {
    const b = new ArrayBuffer(8);
    new DataView(b).setFloat64(0, m, true);
    parts.push(...new Uint8Array(b));
  }
  return new Uint8Array(parts).buffer;
}

describe("readVariableRecord", () => {
  test("numeric variable, no label, no missing", () => {
    const v = readVariableRecord(new Cursor(varBody({ type: 0, name: "id" })), DEC);
    expect(v).not.toBe("continuation");
    if (v !== "continuation") {
      expect(v.name).toBe("id");
      expect(v.type).toBe(0);
      expect(v.missing.kind).toBe("none");
    }
  });
  test("continuation record returns 'continuation'", () => {
    expect(readVariableRecord(new Cursor(varBody({ type: -1, name: "" })), DEC)).toBe(
      "continuation",
    );
  });
  test("variable label is read and 4-byte padded", () => {
    const v = readVariableRecord(
      new Cursor(varBody({ type: 0, hasLabel: true, label: "My var", name: "x" })),
      DEC,
    );
    if (v !== "continuation") expect(v.label).toBe("My var");
  });
  test("range missing (n=-2) → range spec", () => {
    const v = readVariableRecord(
      new Cursor(varBody({ type: 0, nMiss: -2, miss: [1, 9], name: "q" })),
      DEC,
    );
    if (v !== "continuation") expect(v.missing).toEqual({ kind: "range", lo: 1, hi: 9 });
  });
  test("discrete missing (n=2) → discrete spec", () => {
    const v = readVariableRecord(
      new Cursor(varBody({ type: 0, nMiss: 2, miss: [98, 99], name: "q" })),
      DEC,
    );
    if (v !== "continuation") expect(v.missing).toEqual({ kind: "discrete", values: [98, 99] });
  });
});

describe("decodeFormat / decodeMissing", () => {
  test("packed format int → {type,width,decimals}", () => {
    // byte0 decimals=2, byte1 width=8, byte2 type=5 → 0x00050802
    expect(decodeFormat(0x00050802)).toMatchObject({ decimals: 2, width: 8, type: 5 });
  });
  test("range+discrete (n=-3)", () => {
    expect(decodeMissing(-3, [1, 9, 99])).toEqual({
      kind: "range+discrete",
      lo: 1,
      hi: 9,
      value: 99,
    });
  });
});

import { describe, expect, test } from "bun:test";
import { Cursor } from "../src/sav/binary.ts";
import { readDictionary } from "../src/sav/dictionary.ts";

// Little-endian byte builders — the loop reads everything through the endian-aware Cursor (little).
function i32(n: number): number[] {
  const b = new ArrayBuffer(4);
  new DataView(b).setInt32(0, n, true);
  return [...new Uint8Array(b)];
}
function f64(n: number): number[] {
  const b = new ArrayBuffer(8);
  new DataView(b).setFloat64(0, n, true);
  return [...new Uint8Array(b)];
}

// A type-2 variable body WITHOUT the leading rec_type int (the loop consumes that separately) —
// mirrors Task 4's varBody: type, has_label=0, n_missing=0, print, write, 8-byte padded name.
function varBody(type: number, name: string): number[] {
  const nm = name.padEnd(8, " ").slice(0, 8);
  return [
    ...i32(type),
    ...i32(0),
    ...i32(0),
    ...i32(0),
    ...i32(0),
    ...new TextEncoder().encode(nm),
  ];
}

// One type-3 value-label entry: 8 raw value bytes + u8 label_len + label bytes, padded so that the
// whole (1 + label_len) rounds up to a multiple of 8.
function labelEntry(value: number, label: string): number[] {
  const enc = [...new TextEncoder().encode(label)];
  const pad = (8 - ((1 + enc.length) % 8)) % 8;
  return [...f64(value), enc.length, ...enc, ...new Array(pad).fill(0)];
}

function buildStream(): ArrayBuffer {
  const parts: number[] = [
    ...i32(2),
    ...varBody(0, "id"),
    ...i32(2),
    ...varBody(0, "age"),
    ...i32(3),
    ...i32(2),
    ...labelEntry(1, "Low"),
    ...labelEntry(2, "High"),
    ...i32(4),
    ...i32(1),
    ...i32(2),
    ...i32(7),
    ...i32(13),
    ...i32(1),
    ...i32(4),
    65,
    66,
    67,
    68,
    ...i32(6),
    ...i32(1),
    ...new Array(80).fill(0),
    ...i32(999),
    ...i32(0),
  ];
  return new Uint8Array(parts).buffer;
}

function f64Of(raw: Uint8Array): number {
  return new DataView(raw.buffer, raw.byteOffset, 8).getFloat64(0, true);
}

describe("readDictionary", () => {
  const dict = readDictionary(new Cursor(buildStream()));

  test("collects variables in order, skipping the type-6 document record", () => {
    expect(dict.variables.length).toBe(2);
    expect(dict.variables.map((v) => v.name)).toEqual(["id", "age"]);
    expect(dict.physicalIndexes).toEqual([1, 2]); // no continuations → physical == logical+1
  });

  test("reads the type-3 value-label set and attaches the type-4 var indexes", () => {
    expect(dict.valueLabelSets.length).toBe(1);
    const set = dict.valueLabelSets[0];
    const dec = new TextDecoder("utf-8");
    expect(set.labels.map((l) => dec.decode(l.labelRaw))).toEqual(["Low", "High"]);
    expect(set.labels.map((l) => f64Of(l.raw))).toEqual([1, 2]);
    expect(set.varIndexes).toEqual([2]);
  });

  test("captures the type-7 extension record's payload verbatim", () => {
    expect(dict.extensions.length).toBe(1);
    const ext = dict.extensions[0];
    expect(ext.subtype).toBe(13);
    expect(ext.size).toBe(1);
    expect(ext.count).toBe(4);
    expect([...ext.bytes]).toEqual([65, 66, 67, 68]);
  });
});

describe("readDictionary physical indexes (string continuations)", () => {
  // A long string (type 16) writes one real record + one type=-1 continuation, so the following
  // numeric variable sits at PHYSICAL index 3 though it is logical index 1. Type-4 value-label
  // indexes are physical, so physicalIndexes must record [1, 3] to attach labels correctly.
  function contStream(): ArrayBuffer {
    const parts: number[] = [
      ...i32(2),
      ...varBody(16, "code"), // real long-string record (width 16)
      ...i32(2),
      ...varBody(-1, ""), // its continuation (physical slot 2, dropped from variables)
      ...i32(2),
      ...varBody(0, "grp"), // numeric at physical slot 3, logical slot 1
      ...i32(999),
      ...i32(0),
    ];
    return new Uint8Array(parts).buffer;
  }

  test("continuation advances the physical position but is not kept", () => {
    const d = readDictionary(new Cursor(contStream()));
    expect(d.variables.map((v) => v.name)).toEqual(["code", "grp"]);
    expect(d.physicalIndexes).toEqual([1, 3]);
  });
});

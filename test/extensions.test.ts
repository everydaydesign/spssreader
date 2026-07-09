import type { RawDict, RawExtension } from "../src/sav/dictionary.ts";

import { describe, expect, test } from "bun:test";

import { applyExtensions } from "../src/sav/extensions.ts";

// Extension payloads are built little-endian (the crafted file's byte order) and read back with
// applyExtensions(raw, true) — mirroring how the real reader passes the header's endianness through.
function strExt(subtype: number, s: string): RawExtension {
  const bytes = new TextEncoder().encode(s);
  return { subtype, size: 1, count: bytes.length, bytes };
}

function f64Ext(subtype: number, nums: number[]): RawExtension {
  const buf = new ArrayBuffer(nums.length * 8);
  const dv = new DataView(buf);
  nums.forEach((n, i) => dv.setFloat64(i * 8, n, true));
  return { subtype, size: 8, count: nums.length, bytes: new Uint8Array(buf) };
}

function i32Ext(subtype: number, ints: number[]): RawExtension {
  const buf = new ArrayBuffer(ints.length * 4);
  const dv = new DataView(buf);
  ints.forEach((n, i) => dv.setInt32(i * 4, n, true));
  return { subtype, size: 4, count: ints.length, bytes: new Uint8Array(buf) };
}

function dict(extensions: RawExtension[]): RawDict {
  return { variables: [], physicalIndexes: [], valueLabelSets: [], extensions };
}

describe("applyExtensions", () => {
  const info = applyExtensions(
    dict([
      strExt(20, "windows-1252"),
      f64Ext(4, [-999.5, 1e300, -1e300]), // sysmis, highest, lowest
      strExt(13, "V1=Age\tV2=Income"),
      strExt(14, "LONGSTR=300\0OTHER=500\0"),
      i32Ext(11, [1, 8, 0, 3, 10, 1, 2, 5, 0]), // 3 vars: nominal / scale / ordinal
    ]),
    true,
  );

  test("subtype 20 → encoding name, trimmed", () => {
    expect(info.encoding).toBe("windows-1252");
  });

  test("subtype 4 → keeps the first f64 as sysmis", () => {
    expect(info.sysmis).toBe(-999.5);
  });

  test("subtype 13 → long variable names, split on tab", () => {
    expect(info.longNames.get("V1")).toBe("Age");
    expect(info.longNames.get("V2")).toBe("Income");
  });

  test("subtype 14 → very-long string widths, split on NUL/tab", () => {
    expect(info.veryLong.get("LONGSTR")).toBe(300);
    expect(info.veryLong.get("OTHER")).toBe(500);
  });

  test("subtype 11 → measures from the first int of each triple", () => {
    expect(info.measures).toEqual(["nominal", "scale", "ordinal"]);
  });
});

describe("applyExtensions defaults", () => {
  test("empty extensions → utf-8 + -MAX_VALUE sysmis + empty maps", () => {
    const info = applyExtensions(dict([]), true);
    expect(info.encoding).toBe("utf-8");
    expect(info.sysmis).toBe(-Number.MAX_VALUE);
    expect(info.longNames.size).toBe(0);
    expect(info.veryLong.size).toBe(0);
    expect(info.measures).toEqual([]);
  });

  test("unhandled subtypes (3/17/18/21/22) are ignored, not thrown", () => {
    const info = applyExtensions(
      dict([
        { subtype: 3, size: 4, count: 8, bytes: new Uint8Array(32) },
        { subtype: 22, size: 1, count: 4, bytes: new Uint8Array(4) },
        strExt(20, "utf-8"),
      ]),
      true,
    );
    expect(info.encoding).toBe("utf-8");
  });

  test('unknown measure code → "unknown"', () => {
    const info = applyExtensions(dict([i32Ext(11, [9, 0, 0])]), true);
    expect(info.measures).toEqual(["unknown"]);
  });
});

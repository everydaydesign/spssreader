import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { CellValue, MissingSpec, Variable } from "../src/index.ts";

import { readSav } from "../src/index.ts";

// Data-driven oracle: every oracle/fixtures/*.sav is read by readSav and asserted, value-for-value
// and metadata-for-metadata, against its *.expected.json — which is R haven's own decode of the
// exact same file (see oracle/generate-fixtures.R). If a value disagrees, the reader is wrong.

const FIXTURE_DIR = join(import.meta.dir, "../oracle/fixtures");

type ExpectedLabel = { value: number | string; label: string };
type ExpectedVar = {
  name: string;
  type: "numeric" | "string";
  valueKind: "number" | "string" | "date" | "datetime";
  values: Array<number | string | null>;
  missing: MissingSpec;
  label?: string;
  valueLabels?: ExpectedLabel[];
};
type Expected = { variables: ExpectedVar[] };

const savFiles = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith(".sav"))
  .sort();

function loadExpected(sav: string): Expected {
  const path = join(FIXTURE_DIR, sav.replace(/\.sav$/, ".expected.json"));
  const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
  if (parsed === null || typeof parsed !== "object" || !("variables" in parsed)) {
    throw new Error(`malformed expected JSON: ${path}`);
  }
  return parsed as Expected; // test-only narrowing of the trusted oracle payload
}

/** ISO-8601 UTC without the always-zero millisecond field, matching the R "%Y-%m-%dT%H:%M:%SZ". */
function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Normalize value labels to a stable, order-independent shape (haven and the reader may differ in
 * emission order; the *set* of (value,label) pairs is what must match). */
function sortedLabels(labels?: Array<{ value: CellValue; label: string }>): string[] {
  return (labels ?? []).map((l) => `${typeof l.value}|${String(l.value)}|${l.label}`).sort();
}

function assertCell(cell: CellValue, expected: number | string | null, kind: string): void {
  if (expected === null) {
    expect(cell).toBeNull();
    return;
  }
  if (kind === "number") {
    expect(cell as number).toBeCloseTo(expected as number, 12);
  } else if (kind === "string") {
    expect(cell).toBe(expected as string);
  } else if (kind === "date") {
    expect((cell as Date).toISOString().slice(0, 10)).toBe(expected as string);
  } else {
    expect(isoSeconds(cell as Date)).toBe(expected as string);
  }
}

function assertVariable(variable: Variable, expected: ExpectedVar): void {
  expect(variable.type).toBe(expected.type);
  expect(variable.label).toBe(expected.label);
  expect(variable.missing).toEqual(expected.missing);
  expect(sortedLabels(variable.valueLabels)).toEqual(sortedLabels(expected.valueLabels));
}

test.each(savFiles)("oracle: %s matches haven", async (sav) => {
  const bytes = await Bun.file(join(FIXTURE_DIR, sav)).arrayBuffer();
  const { sheets } = await readSav(bytes);
  const { variables, rows } = sheets[0];
  const expected = loadExpected(sav);

  expect(variables.map((v) => v.name)).toEqual(expected.variables.map((e) => e.name));
  expect(rows.length).toBe(expected.variables[0].values.length);

  expected.variables.forEach((e, col) => {
    assertVariable(variables[col], e);
    e.values.forEach((exp, row) => assertCell(rows[row][col], exp, e.valueKind));
  });
});

// haven / ReadStat writes little-endian only, so no big-endian .sav can be produced from the same
// oracle path. A real big-endian test would need a hand-byte-swapped file (swap every header i32 +
// the bias f64, every dictionary record int/float, and each data-section f64 while leaving 8-byte
// string cells and RLE control octets byte-order-invariant) — an error-prone re-implementation of a
// writer whose only job is to flip cur.little. The header's byte-order probe (layout_code === 2|3)
// and every endian-aware read are exercised by the little-endian matrix above; the big-endian branch
// is left explicitly skipped rather than silently unexercised.
test.skip("big-endian: no haven producer (see comment)", () => {});

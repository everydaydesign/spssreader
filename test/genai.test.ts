import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { CellValue, MissingSpec, Variable } from "../src/index.ts";

import { readSav } from "../src/index.ts";

// Real-world acceptance test — the reason this package exists. The user's actual GenAI.sav
// (110 vars x ~507 cases; the exact file that CRASHED the `jsavvy` library) is read by readSav and
// asserted, value-for-value and metadata-for-metadata, against R haven's own decode of the SAME
// file (genai.expected.json, produced locally by haven::read_sav; see the R oracle in the task).
//
// PRIVACY: both GenAI.sav and genai.expected.json are the user's PRIVATE research data and are
// git-ignored — NEVER committed. This test file self-skips when the .sav is absent, so the suite
// stays green for anyone (CI, teammates) who does not have the private file.

const SAV_PATH = join(import.meta.dir, "data/GenAI.sav");
const EXPECTED_PATH = join(import.meta.dir, "data/genai.expected.json");

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

function loadExpected(): Expected {
  const parsed: unknown = JSON.parse(readFileSync(EXPECTED_PATH, "utf-8"));
  if (parsed === null || typeof parsed !== "object" || !("variables" in parsed)) {
    throw new Error(`malformed expected JSON: ${EXPECTED_PATH}`);
  }
  return parsed as Expected; // test-only narrowing of the trusted local oracle payload
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
  expect(variable.name).toBe(expected.name);
  expect(variable.type).toBe(expected.type);
  expect(variable.label).toBe(expected.label);
  expect(variable.missing).toEqual(expected.missing);
  expect(sortedLabels(variable.valueLabels)).toEqual(sortedLabels(expected.valueLabels));
}

if (!existsSync(SAV_PATH)) {
  test.skip("GenAI.sav not present — drop the private file at test/data/GenAI.sav (git-ignored) to run the real-world acceptance test", () => {});
} else {
  test("GenAI.sav real-world acceptance: 110 vars x 507 cases parse and match haven", async () => {
    const bytes = await Bun.file(SAV_PATH).arrayBuffer();
    // Parses without throwing — this exact file crashed jsavvy.
    const { sheets } = await readSav(bytes);
    expect(sheets.length).toBe(1);
    const { variables, rows } = sheets[0];
    const expected = loadExpected();

    // Case count (~507) and variable count (110) match haven.
    expect(variables.length).toBe(expected.variables.length);
    expect(variables.length).toBe(110);
    expect(rows.length).toBe(expected.variables[0].values.length);
    expect(rows.length).toBe(507);

    // Variable names + types (and full metadata) match haven.
    expect(variables.map((v) => v.name)).toEqual(expected.variables.map((e) => e.name));

    // The whole matrix — the real backstop for >=3-segment very-long strings and real-world edges.
    expected.variables.forEach((e, col) => {
      assertVariable(variables[col], e);
      expect(rows.every((row) => row.length === expected.variables.length)).toBe(true);
      e.values.forEach((exp, row) => assertCell(rows[row][col], exp, e.valueKind));
    });
  });
}

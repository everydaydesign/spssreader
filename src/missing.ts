import type { CellValue, MissingSpec, Sheet } from "./types";

/** True when the numeric `cell` matches a numeric `spec` (discrete / range / range+discrete). */
function numberMatches(cell: number, spec: MissingSpec): boolean {
  switch (spec.kind) {
    case "discrete":
      return spec.values.includes(cell);
    case "range":
      return cell >= spec.lo && cell <= spec.hi;
    case "range+discrete":
      return (cell >= spec.lo && cell <= spec.hi) || cell === spec.value;
    default:
      return false; // "none" | "strings" never match a number
  }
}

/**
 * True when `cell` matches the variable's declared user-missing `spec`.
 * Only plain numbers/strings can match; a `Date` or already-`null` cell never does.
 */
function isMissing(cell: CellValue, spec: MissingSpec): boolean {
  if (typeof cell === "number") return numberMatches(cell, spec);
  if (typeof cell === "string") return spec.kind === "strings" && spec.values.includes(cell);
  return false;
}

/**
 * Return a new {@link Sheet} in which every cell matching its variable's
 * declared {@link MissingSpec} is replaced by `null` (user-missing → system-missing).
 * Non-mutating: fresh `rows` and fresh inner arrays; the input is left untouched.
 */
export function applyUserMissing(sheet: Sheet): Sheet {
  const specs = sheet.variables.map((v) => v.missing);
  const rows = sheet.rows.map((row) =>
    row.map((cell, col) => (isMissing(cell, specs[col]) ? null : cell)),
  );
  return { ...sheet, rows };
}

export type CellValue = string | number | Date | null; // null = system-missing
export type Measure = "nominal" | "ordinal" | "scale" | "unknown";

export type MissingSpec =
  | { kind: "none" }
  | { kind: "discrete"; values: number[] }
  | { kind: "range"; lo: number; hi: number }
  | { kind: "range+discrete"; lo: number; hi: number; value: number }
  | { kind: "strings"; values: string[] };

export type SpssFormat = { type: number; width: number; decimals: number; isDate: boolean };

export type Variable = {
  name: string;
  label?: string;
  type: "numeric" | "string";
  width?: number;
  missing: MissingSpec;
  valueLabels?: Array<{ value: CellValue; label: string }>;
  format: SpssFormat;
  measure: Measure;
};

export type Format = "csv" | "tsv" | "txt" | "xlsx" | "sav";
export type Sheet = { name: string; variables: Variable[]; rows: CellValue[][] };
export type ParsedFile = { format: Format; encoding?: string; sheets: Sheet[] };

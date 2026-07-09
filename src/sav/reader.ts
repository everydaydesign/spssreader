import type { SavLimits } from "../limits";
import type { CellValue, ParsedFile, Variable } from "../types";
import type { VariablePlan } from "./cases";
import type { RawDict, RawValueLabelSet } from "./dictionary";
import type { DictInfo } from "./extensions";
import type { RawVariable } from "./variable";

import { DEFAULT_LIMITS, SavError } from "../limits";
import { Cursor } from "./binary";
import { readCases, toBunEncoding } from "./cases";
import { isDateFormat } from "./dates";
import { readDictionary } from "./dictionary";
import { applyExtensions } from "./extensions";
import { readHeader } from "./header";
import { inflateZsav, makeSource } from "./source";

type ValueLabel = { value: CellValue; label: string };

/** Everything `buildVariable`/`buildPlans` need beyond the raw variable itself, bundled so the
 * builders stay within the parameter budget. */
type BuildContext = { info: DictInfo; sets: RawValueLabelSet[]; little: boolean; dec: TextDecoder };

/** Read 8 raw value-label bytes as a numeric f64 key, in the file's byte order. */
function rawToF64(raw: Uint8Array, little: boolean): number {
  return new DataView(raw.buffer, raw.byteOffset, 8).getFloat64(0, little);
}

/** Collect the value labels attached to the variable at 1-based PHYSICAL dictionary index
 * `physicalIndex` (type-4 var indexes count string continuations, which `raw.variables` drops),
 * decoding each key by the owning variable's kind: numeric → f64, string → trimmed decoded bytes,
 * and the label text with the file encoding. */
function valueLabelsFor(
  physicalIndex: number,
  isString: boolean,
  sets: RawValueLabelSet[],
  little: boolean,
  dec: TextDecoder,
): ValueLabel[] | undefined {
  const out: ValueLabel[] = [];
  for (const set of sets) {
    if (!set.varIndexes.includes(physicalIndex)) continue;
    for (const entry of set.labels) {
      const value = isString
        ? dec.decode(entry.raw).replace(/ +$/, "")
        : rawToF64(entry.raw, little);
      out.push({ value, label: dec.decode(entry.labelRaw).replace(/\0+$/, "") });
    }
  }
  return out.length > 0 ? out : undefined;
}

/** The name/type/format/measure common to every variable, before optional fields are attached. */
function baseVariable(rawVar: RawVariable, index: number, info: DictInfo): Variable {
  return {
    name: info.longNames.get(rawVar.name) ?? rawVar.name,
    type: rawVar.type > 0 ? "string" : "numeric",
    missing: rawVar.missing,
    format: { ...rawVar.print, isDate: isDateFormat(rawVar.print.type) },
    measure: info.measures[index] ?? "unknown",
  };
}

/** Assemble one `Variable` from its raw record plus the extension-derived long name, measure, real
 * date-format flag, and any value labels resolved against the owning variable's numeric/string kind.
 * `physicalIndex` is the variable's 1-based position INCLUDING continuations (value-label indexing). */
function buildVariable(
  rawVar: RawVariable,
  index: number,
  physicalIndex: number,
  ctx: BuildContext,
): Variable {
  const isString = rawVar.type > 0;
  const variable = baseVariable(rawVar, index, ctx.info);
  if (rawVar.label !== undefined) variable.label = rawVar.label;
  if (isString) variable.width = rawVar.type;
  const valueLabels = valueLabelsFor(physicalIndex, isString, ctx.sets, ctx.little, ctx.dec);
  if (valueLabels) variable.valueLabels = valueLabels;
  return variable;
}

/** The `ceil(realWidth/252)` segment allocated-widths of a very-long string, read from the segment
 * sub-variables that immediately follow it in the dictionary (SPSS packs one string variable per
 * segment: first segments alloc 255, the last alloc `realWidth − 252·(n−1)`). */
function segmentWidths(raw: RawDict, start: number, realWidth: number): number[] {
  const n = Math.ceil(realWidth / 252);
  const widths: number[] = [];
  for (let s = 0; s < n && start + s < raw.variables.length; s++) {
    widths.push(raw.variables[start + s].type);
  }
  return widths;
}

/** Turn the raw variable list into read plans, merging each very-long string's N segment
 * sub-variables (identified by its short name in `info.veryLong`) into ONE logical string variable
 * of the real width. Normal strings get a single-segment plan; numerics get an empty plan. */
function buildPlans(raw: RawDict, ctx: BuildContext): VariablePlan[] {
  const plans: VariablePlan[] = [];
  let i = 0;
  while (i < raw.variables.length) {
    const rawVar = raw.variables[i];
    const variable = buildVariable(rawVar, i, raw.physicalIndexes[i], ctx);
    const realWidth = rawVar.type > 0 ? ctx.info.veryLong.get(rawVar.name) : undefined;
    if (realWidth === undefined) {
      plans.push({ variable, segments: rawVar.type > 0 ? [rawVar.type] : [] });
      i += 1;
      continue;
    }
    const segments = segmentWidths(raw, i, realWidth);
    variable.width = realWidth;
    plans.push({ variable, segments });
    i += segments.length;
  }
  return plans;
}

/** Read an SPSS `.sav`/`.zsav` system file end-to-end: header → dictionary → extensions → variables
 * → (inflate if ZSAV) → data cases. Matches R `haven` on the committed golden fixtures. `opts`
 * tightens the resource ceilings (see `SavLimits`); a hostile file is rejected with a `SavError`. */
export async function readSav(buf: ArrayBuffer, opts?: Partial<SavLimits>): Promise<ParsedFile> {
  const limits = { ...DEFAULT_LIMITS, ...opts };
  let cur = new Cursor(buf);
  const header = readHeader(cur);
  const raw = readDictionary(cur);
  const info = applyExtensions(raw, cur.little);
  const little = cur.little; // capture before a ZSAV swap: the bytecode literals keep the file's order
  const dec = new TextDecoder(toBunEncoding(info.encoding));
  const plans = buildPlans(raw, { info, sets: raw.valueLabelSets, little, dec });
  const variables = plans.map((plan) => plan.variable);
  // No variables ⇒ every row consumes 0 cells, so the unknown-count (`ncases = -1`) loop can never
  // advance — reject instead of spinning forever.
  if (variables.length === 0) throw new SavError("file has no variables");
  if (header.ncases >= 0 && header.ncases * variables.length > limits.maxCells) {
    throw new SavError(
      `case count ${header.ncases} × ${variables.length} vars exceeds cell limit ${limits.maxCells}`,
    );
  }
  if (header.zlib) {
    const data = await inflateZsav(cur, limits.maxInflatedBytes);
    cur = new Cursor(data);
    cur.little = little;
  }
  const source = makeSource(cur, header, info.sysmis);
  const rows = readCases(header, plans, info, source, limits);
  return { format: "sav", encoding: info.encoding, sheets: [{ name: "data", variables, rows }] };
}

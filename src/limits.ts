/** Thrown for any malformed or hostile `.sav` input that a resource bound rejects — a bad file, not
 * a reader bug. Distinct from the plain `Error`s raised for unsupported-but-valid constructs so a
 * caller can `catch` an attack (OOM/hang avoidance) separately if it wants to. */
export class SavError extends Error {}

/** Resource ceilings that keep a hostile `.sav` from exhausting memory or looping unboundedly. The
 * defaults are generous, so no well-formed file is affected; pass a stricter `readSav(buf, opts)` in
 * memory-constrained environments. */
export type SavLimits = {
  /** Maximum `ncases × nvars` data cells the reader will materialize (~500k rows × 100 vars). */
  maxCells: number;
  /** Cumulative inflate output ceiling: total bytes a ZSAV may inflate to before the reader aborts (512 MiB). */
  maxInflatedBytes: number;
};

export const DEFAULT_LIMITS: SavLimits = {
  maxCells: 50_000_000,
  maxInflatedBytes: 512 * 1024 * 1024,
};

# spssreader

**Correct, zero-dependency SPSS `.sav`/`.zsav` reader for the browser and Node — validated against R [`haven`](https://haven.tidyverse.org/).**

`spssreader` parses IBM SPSS system files (`.sav`) and their compressed variant (`.zsav`) into plain
JavaScript values: numbers, strings, `Date`s, variable metadata, value labels, and declared missing
values. It is written in pure TypeScript against Web platform APIs (`ArrayBuffer`, `DataView`,
`TextDecoder`, `DecompressionStream`) — **no runtime dependencies**, and the same build runs in the
browser and in Node.

## Why

SPSS `.sav` files are everywhere in the social sciences, market research, and public data, but the
JavaScript ecosystem lacked a reader that decodes *real* files correctly — most tools stumble on RLE
compression, ZSAV (zlib) blocks, very-long strings, encodings, or the exact bit-level meaning of
system- vs. user-missing values. Getting any of those wrong silently corrupts data.

`spssreader` was built to be correct first: every construct is validated value-for-value against R's
`haven`/`ReadStat`, the de-facto reference implementation. It uses only Web APIs, so it ships as a
single ESM module with zero dependencies and no native addons — drop it into a browser upload flow
or a Node script alike.

## Install

```bash
npm i spssreader
```

```bash
bun add spssreader
pnpm add spssreader
yarn add spssreader
```

## Usage

### Browser — a picked/dropped `File`

```ts
import { readSav, applyUserMissing } from "spssreader";

const input = document.querySelector<HTMLInputElement>("#file");
input.addEventListener("change", async () => {
  const file = input.files?.[0];
  if (!file) return;

  const parsed = await readSav(await file.arrayBuffer());
  const sheet = parsed.sheets[0];

  console.log(sheet.variables.map((v) => v.name)); // column names
  console.log(sheet.rows.length); // row count

  // Replace every declared user-missing cell with null before analysis:
  const clean = applyUserMissing(sheet);
  console.log(clean.rows[0]);
});
```

### React — a file input

```tsx
import { useState } from "react";
import { readSav, applyUserMissing, type Sheet } from "spssreader";

export function SavImporter() {
  const [sheet, setSheet] = useState<Sheet | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const { sheets } = await readSav(await file.arrayBuffer());
    setSheet(applyUserMissing(sheets[0]));
  }

  return (
    <>
      <input type="file" accept=".sav" onChange={onFile} />
      {sheet && (
        <p>
          {sheet.rows.length} rows × {sheet.variables.length} variables
        </p>
      )}
    </>
  );
}
```

### Node — a file on disk

```ts
import { readFile } from "node:fs/promises";
import { readSav } from "spssreader";

const nodeBuf = await readFile("survey.sav");

// Slice an exact ArrayBuffer (Node pools Buffers behind a shared store):
const bytes = nodeBuf.buffer.slice(
  nodeBuf.byteOffset,
  nodeBuf.byteOffset + nodeBuf.byteLength,
);

const parsed = await readSav(bytes);
for (const v of parsed.sheets[0].variables) {
  console.log(v.name, v.type, v.label ?? "");
}
```

### Reading variables and rows

```ts
import { readSav, type CellValue } from "spssreader";

const { sheets, encoding } = await readSav(buffer);
const { variables, rows } = sheets[0];

// `rows` is CellValue[][], column-aligned to `variables` by index.
const genderCol = variables.findIndex((v) => v.name === "gender");
const genderValues: CellValue[] = rows.map((row) => row[genderCol]);

// A variable's value labels (e.g. 1 -> "Male", 2 -> "Female"):
const gender = variables[genderCol];
console.log(gender.valueLabels); // [{ value: 1, label: "Male" }, ...]
console.log(encoding); // e.g. "utf-8" or "windows-1252"
```

## API

### `readSav(buf, opts?)`

```ts
function readSav(
  buf: ArrayBuffer,
  opts?: Partial<SavLimits>,
): Promise<ParsedFile>;
```

Reads a `.sav`/`.zsav` file end-to-end (header → dictionary → extensions → variables → data cases,
inflating ZSAV blocks as needed) and resolves to a `ParsedFile`. `opts` tightens the resource
ceilings (see [Security & limits](#security--limits)). Rejects with a `SavError` on malformed or
hostile input.

### `applyUserMissing(sheet)`

```ts
function applyUserMissing(sheet: Sheet): Sheet;
```

Returns a **new** `Sheet` in which every cell matching its variable's declared `MissingSpec` is
replaced by `null` (user-missing → system-missing). Non-mutating — the input sheet is untouched. Use
it when you want declared missing codes treated as missing; skip it when you need the literal codes.

### `SavError`

```ts
class SavError extends Error {}
```

Thrown when a resource bound rejects a malformed or hostile file (a bad file, not a reader bug).
Because it extends `Error`, a plain `catch` still catches it; check `err instanceof SavError` to
distinguish a rejected/hostile file from a genuinely unsupported-but-valid construct (which throws a
plain `Error`).

### `DEFAULT_LIMITS`

```ts
const DEFAULT_LIMITS: SavLimits = {
  // ncases × nvars ceiling (~500k rows × 100 vars)
  maxCells: 50_000_000,
  // ZSAV inflate output ceiling (512 MiB)
  maxInflatedBytes: 512 * 1024 * 1024,
};
```

The generous defaults that `readSav` merges your `opts` over. No well-formed file is affected.

### Types

```ts
// null = system-missing
type CellValue = string | number | Date | null;

type Measure = "nominal" | "ordinal" | "scale" | "unknown";

type MissingSpec =
  | { kind: "none" }
  | { kind: "discrete"; values: number[] }
  | { kind: "range"; lo: number; hi: number }
  | { kind: "range+discrete"; lo: number; hi: number; value: number }
  | { kind: "strings"; values: string[] };

type SpssFormat = {
  type: number;
  width: number;
  decimals: number;
  isDate: boolean;
};

type Variable = {
  name: string;
  label?: string;
  type: "numeric" | "string";
  // string byte width, or the merged width for very-long strings
  width?: number;
  missing: MissingSpec;
  valueLabels?: Array<{ value: CellValue; label: string }>;
  format: SpssFormat;
  measure: Measure;
};

type Sheet = {
  name: string;
  variables: Variable[];
  rows: CellValue[][];
};

type ParsedFile = {
  format: "sav";
  encoding?: string;
  sheets: Sheet[];
};

type SavLimits = {
  maxCells: number;
  maxInflatedBytes: number;
};
```

For a `.sav` file, `sheets` always contains exactly one sheet (named `"data"`); `rows` is row-major
and column-aligned to `variables`.

**Missing values.** `null` in a cell is always **system-missing**. Declared **user-missing** values
(a survey's `99 = "no answer"`, or a range) are kept as their literal number/string so you can see
them — call `applyUserMissing(sheet)` to fold them to `null`. A variable's declaration is on
`variable.missing`:

- `{ kind: "none" }` — no declared missing values.
- `{ kind: "discrete", values }` — up to three discrete codes.
- `{ kind: "range", lo, hi }` — a missing range `[lo, hi]`.
- `{ kind: "range+discrete", lo, hi, value }` — a range plus one discrete code.
- `{ kind: "strings", values }` — discrete codes for a string variable.

## Format coverage

| Area           | Supported                                                            |
| -------------- | ------------------------------------------------------------------- |
| Magic          | `$FL2` (uncompressed / RLE) and `$FL3` (ZSAV)                        |
| Compression    | uncompressed, RLE (SPSS bytecode), ZSAV (zlib `deflate` blocks)      |
| Variables      | numeric, string, and very-long strings (> 255 bytes, segment-merged) |
| Dates          | SPSS date/time formats decoded to JavaScript `Date`                 |
| Value labels   | numeric and string value-label sets, resolved per variable          |
| Missing values | discrete, range, range + discrete, and string missing specs         |
| Encodings      | file-declared encoding via `TextDecoder` (UTF-8, windows-125x, …)   |
| Endianness     | little-endian                                                       |

## Correctness

Every supported construct is validated **value-for-value against R `haven`** (which wraps the
`ReadStat` C library) across a fixture matrix covering compression modes, numeric/string/very-long
variables, dates, value labels, each missing-value kind, and encodings — plus a real-world 2.78 MB
survey file. The oracle fixtures live alongside the source and are asserted on every test run.

## Security & limits

`spssreader` is designed to parse **untrusted** files safely. A hostile `.sav` cannot make it OOM or
hang: every attacker-controlled allocation and loop is bounded, and any bound violation throws a
catchable `SavError` rather than exhausting memory or spinning.

- Reads never allocate beyond the remaining file bytes.
- The data-cell budget (`maxCells`) and the ZSAV inflate budget (`maxInflatedBytes`) are enforced
  while streaming, so a decompression bomb aborts before it materializes.
- Malformed dictionaries, out-of-spec record counts, and truncated headers are rejected up front.

Tune the ceilings for memory-constrained environments:

```ts
await readSav(buf, {
  maxCells: 5_000_000,
  maxInflatedBytes: 64 * 1024 * 1024,
});
```

Recommendations for consumers:

- Still bound the **input** size before you hand a buffer to `readSav` (reject files larger than you
  expect for your use case).
- Treat `Variable.name` (and other file-derived strings) as **untrusted** — don't use a variable
  name as a plain-object key without care; prefer a `Map` or a `null`-prototype object to avoid
  prototype-pollution surprises from adversarial names.

## Roadmap

`spssreader` reads modern little-endian `.sav`/`.zsav` files correctly today, and is intentionally
read-only. On the map for future releases:

- **Big-endian system files** — the header already detects byte order; big-endian *data* reading and
  `haven` validation are not yet implemented.
- **Portable `.por` format** — the older text-based SPSS portable format.
- **Writing `.sav` files** — the reader is read-only; a writer is a possible future addition.

Issues and contributions are welcome at
[github.com/everydaydesign/spssreader](https://github.com/everydaydesign/spssreader).

## License

MIT © 2026 everydaydesign

## Credits

- The [PSPP System File Format](https://www.gnu.org/software/pspp/pspp-dev/html_node/System-File-Format.html)
  documentation — the specification this reader implements.
- R [`haven`](https://haven.tidyverse.org/) and [`ReadStat`](https://github.com/WizardMac/ReadStat) —
  the validation oracle every fixture is checked against.

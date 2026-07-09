# dataread golden-fixture oracle (DEV-TIME ONLY). Run: bun run fixtures
# Emits foo.sav + foo.expected.json for a matrix of compression x types x missing x labels x
# encoding x dates x shape. Expected JSON is produced by haven::read_sav's own view of each frame,
# so the TypeScript reader is asserted value-for-value against R haven / ReadStat.
suppressMessages({ library(haven); library(jsonlite) })
.args <- commandArgs(trailingOnly = FALSE)
.file <- sub("^--file=", "", .args[grep("^--file=", .args)])
pkg   <- normalizePath(file.path(dirname(normalizePath(.file)), ".."))
fix   <- file.path(pkg, "oracle", "fixtures"); dir.create(fix, recursive = TRUE, showWarnings = FALSE)

# ---- per-variable metadata extractors (mirror the TS `Variable` shape) --------------------------
var_type <- function(col) if (is.character(col)) "string" else "numeric"

value_kind <- function(col) {
  if (inherits(col, "POSIXct")) return("datetime")
  if (inherits(col, "Date")) return("date")
  if (is.character(col)) return("string")
  "number"
}

fmt_values <- function(col) {
  if (inherits(col, "POSIXct")) return(format(col, "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"))
  if (inherits(col, "Date")) return(format(col, "%Y-%m-%d"))
  if (is.character(col)) return(as.character(col))
  as.numeric(col)
}

# MissingSpec: matches decodeMissing() — discrete / range / range+discrete / strings / none.
# exact = TRUE: base `attr` partial-matches, so "label" would otherwise resolve to "labels".
missing_spec <- function(col) {
  nav <- attr(col, "na_values", exact = TRUE); nar <- attr(col, "na_range", exact = TRUE)
  if (!is.null(nav) && is.character(nav)) return(list(kind = "strings", values = as.list(as.character(nav))))
  if (!is.null(nar) && !is.null(nav)) {
    return(list(kind = "range+discrete", lo = nar[1], hi = nar[2], value = as.numeric(nav)[1]))
  }
  if (!is.null(nar)) return(list(kind = "range", lo = nar[1], hi = nar[2]))
  if (!is.null(nav)) return(list(kind = "discrete", values = as.list(as.numeric(nav))))
  list(kind = "none")
}

value_labels <- function(col) {
  labs <- attr(col, "labels", exact = TRUE)
  if (is.null(labs)) return(NULL)
  vals <- unname(labs); nms <- names(labs)
  lapply(seq_along(labs), function(i)
    list(value = if (is.character(vals)) vals[i] else as.numeric(vals[i]), label = nms[i]))
}

dump <- function(df, path) {
  vars <- lapply(names(df), function(n) {
    col <- df[[n]]
    v <- list(name = n, type = var_type(col), valueKind = value_kind(col),
              values = fmt_values(col), missing = missing_spec(col))
    lab <- attr(col, "label", exact = TRUE)
    if (!is.null(lab)) v$label <- lab           # OMIT a null label (do NOT serialize NULL -> {})
    vl <- value_labels(col)
    if (!is.null(vl)) v$valueLabels <- vl
    v
  })
  write_json(list(variables = vars), path, auto_unbox = TRUE, digits = 17, na = "null")
}

# read_sav round-trips the frame through the actual .sav we ship, so the expected JSON reflects
# ReadStat's own decode (long names, labels, missing, dates) — the true oracle. user_na = TRUE keeps
# user-missing values as their stored value + the na_values/na_range attributes (the reader does the
# same: SPSS stores user-missing as a real value, not system-missing).
emit <- function(df, name, compress = "byte") {
  sav <- file.path(fix, paste0(name, ".sav"))
  write_sav(df, sav, compress = compress)
  dump(read_sav(sav, user_na = TRUE), file.path(fix, paste0(name, ".expected.json")))
  cat(sprintf("wrote %s (%s)\n", name, compress))
}

# ---- COMPRESSION: byte (RLE) / none / zsav (ZLIB), same numeric+string frame -------------------
basic <- data.frame(id = c(1, 2, 3), score = c(5.5, 2.25, 9.0),
                    name = c("alice", "bob", "carol"), stringsAsFactors = FALSE)
emit(basic, "basic", "byte")
emit(basic, "uncompressed", "none")
emit(basic, "zsav", "zsav")

# ---- TYPES: very-long string (>255) alongside numeric + short string ----------------------------
long_text <- paste(rep("The quick brown fox jumps over the lazy dog. ", 10), collapse = "")
stopifnot(nchar(long_text) > 255)
longstring <- data.frame(
  id  = c(10, 20, 30),
  bio = c(long_text, "short bio", paste(rep("x", 300), collapse = "")),
  tag = c("aa", "bb", "cc"),
  stringsAsFactors = FALSE)
emit(longstring, "longstring", "byte")

# ---- DATES: Date + POSIXct (UTC) + a plain numeric ---------------------------------------------
dates <- data.frame(
  d  = as.Date(c("2020-01-15", "1999-12-31", "2024-02-29")),
  dt = as.POSIXct(c("2020-01-02 03:04:05", "1985-06-07 23:59:59", "2001-09-11 08:46:00"), tz = "UTC"),
  n  = c(1.5, 2.5, 3.5))
emit(dates, "dates", "byte")

# ---- MISSING: discrete na_values / range na_range / range+discrete / string missing ------------
missing <- data.frame(
  disc = labelled_spss(c(1, 2, 98, 99), na_values = c(98, 99)),
  rng  = labelled_spss(c(50, 91, 95, 99), na_range = c(90, 99)),
  both = labelled_spss(c(10, 91, 97, 99), na_range = c(90, 98), na_values = 99),
  strm = labelled_spss(c("a", "b", "z", "c"), na_values = "z"))
emit(missing, "missing", "byte")

# ---- VALUE LABELS: numeric labelled + string labelled ------------------------------------------
labels <- data.frame(
  sex   = labelled(c(1, 2, 1, 2), labels = c(Male = 1, Female = 2), label = "Sex"),
  grade = labelled(c("A", "B", "A", "C"),
                   labels = c(Excellent = "A", Good = "B", Poor = "C")),
  plain = c(10, 20, 30, 40))
emit(labels, "labels", "byte")

# ---- LABEL INDEX ALIGNMENT: a long string (continuation records) PRECEDES a labelled numeric ---
labels_order <- data.frame(
  code = c("alpha-bravo-1234", "charlie-delta-56", "echo-foxtrot-789"),   # >8 bytes -> continuations
  grp  = labelled(c(1, 2, 3), labels = c(Control = 1, Treated = 2, Placebo = 3), label = "Group"))
emit(labels_order, "labels_order", "byte")

# ---- ENCODING: non-ASCII (UTF-8) text + a non-ASCII value label --------------------------------
encoding <- data.frame(
  city = c("Zürich", "Malmö", "São Paulo"),
  note = labelled(c(1, 2, 1),
                  labels = c("café" = 1, "naïve" = 2), label = "Crème"),
  stringsAsFactors = FALSE)
emit(encoding, "encoding", "byte")

# ---- SHAPE: wide 110-numeric x 500-row frame (like GenAI) --------------------------------------
set.seed(42)
wide <- as.data.frame(matrix(rnorm(110 * 500), nrow = 500, ncol = 110))
names(wide) <- sprintf("v%03d", seq_len(110))
emit(wide, "wide", "byte")

cat("done\n")

// SPSS format-type codes whose stored seconds-since-epoch map to a CALENDAR date/datetime:
// DATE 20, DATETIME 22, ADATE 23, JDATE 24, MOYR 28, QYR 29, WKYR 30, EDATE 38, SDATE 39.
// Deliberately EXCLUDED (they store seconds/counts but are not calendar dates, and haven decodes
// them as durations / labelled numerics, not dates): TIME 21, DTIME 25, WKDAY 26, MONTH 27.
// haven writes as.Date → 20 and as.POSIXct → 22 (verified against the dates fixture).
const DATE_FORMAT_TYPES = new Set([20, 22, 23, 24, 28, 29, 30, 38, 39]);

// Seconds between the SPSS epoch (1582-10-14 00:00, the Gregorian calendar reform) and the Unix epoch.
const SPSS_EPOCH_OFFSET_SECONDS = 12219379200;

/** True for the SPSS date/datetime format types whose stored seconds map to a calendar date. */
export function isDateFormat(type: number): boolean {
  return DATE_FORMAT_TYPES.has(type);
}

/** Convert an SPSS date value (seconds since 1582-10-14) to a JS `Date`. */
export function spssToDate(seconds: number): Date {
  return new Date((seconds - SPSS_EPOCH_OFFSET_SECONDS) * 1000);
}

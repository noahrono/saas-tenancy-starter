/** Spreadsheets run a cell starting with one of these as a formula, so they are defused with a leading `'`. */
const FORMULA_START = /^[=+\-@]/;
const NEEDS_QUOTES = /[",\r\n]/;

export function escapeCsvField(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** RFC 4180 CSV: rows joined with CRLF, ending with one. */
export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map(escapeCsvField).join(',')).join('\r\n') + '\r\n';
}

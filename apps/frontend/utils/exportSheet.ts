/**
 * Writing a list screen out as a spreadsheet.
 *
 * The workbook writer is far larger than any screen that offers the button and
 * most visits never press it, so `xlsx` is imported at the moment of the click
 * rather than shipped with the route. Everything else in this file is pure, so
 * the naming and cell rules can be tested without a DOM or a download.
 */

export type SheetCell = string | number | null | undefined;
export type SheetRow = Record<string, SheetCell>;

export interface Sheet {
  name: string;
  rows: SheetRow[];
}

/**
 * A tab name a workbook will actually accept.
 *
 * Excel caps a sheet name at 31 characters and refuses the six characters
 * below outright. A name that breaks either rule makes the whole file fail to
 * open, which reads to the user as "the export is broken" rather than "the tab
 * was called something illegal".
 */
export function sheetTabName(name: string): string {
  const cleaned = name.replace(/[\\/?*[\]:]/g, ' ').trim();
  return (cleaned || 'Sheet').slice(0, 31);
}

/**
 * Replace an absent value with a BLANK cell rather than a zero.
 *
 * A rate or a count that was never measured is not nought. Written as 0 it
 * joins every average and total somebody builds on the sheet afterwards, and
 * there is nothing left in the file to say it was invented.
 */
export function blankMissing(row: SheetRow): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value === null || value === undefined ? '' : value;
  }
  return out;
}

/** `contracts-2026-09-05` — the filename a reader can sort a downloads folder by. */
export function datedStem(prefix: string, today: Date = new Date()): string {
  const iso = new Date(
    Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()),
  )
    .toISOString()
    .slice(0, 10);
  return `${prefix}-${iso}`;
}

/** Build the workbook and hand it to the browser as a download. */
export async function exportWorkbook(stem: string, sheets: Sheet[]): Promise<void> {
  const XLSX = await import('xlsx');

  const book = XLSX.utils.book_new();
  for (const sheet of sheets) {
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.json_to_sheet(sheet.rows.map(blankMissing)),
      sheetTabName(sheet.name),
    );
  }
  XLSX.writeFile(book, `${stem}.xlsx`);
}

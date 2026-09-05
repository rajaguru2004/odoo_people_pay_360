/**
 * The fixed column block of the employee Excel import.
 *
 * This is the contract between two pieces of code that must agree exactly:
 *
 *   - `generateImportTemplate()` writes these headers, in this order, and then
 *     appends the active template's custom fields after them.
 *   - `previewImport()` reads the fixed block **by column index** and the custom
 *     columns **by header text**, skipping anything inside the fixed block.
 *
 * They used to hold that agreement as two separate hardcoded numbers, and they
 * disagreed: `phoneCountryCode` was appended as column 14 on one branch while
 * the custom-column guard on another still read `colNumber > 13`. Merged, the
 * first custom column landed at index 14 and could be read as the phone region
 * — a silent mis-import, not an error. Deriving both from this one array is what
 * makes that class of bug impossible rather than merely fixed.
 *
 * APPEND ONLY. Inserting a column shifts every field after it in the sheets
 * customers already have on disk, and `previewImport` reads those by position.
 */
export interface FixedImportColumn {
  header: string;
  key: string;
  width: number;
}

export const FIXED_IMPORT_COLUMNS: readonly FixedImportColumn[] = [
  { header: 'Full Name *', key: 'fullName', width: 25 },
  { header: 'Email *', key: 'email', width: 30 },
  { header: 'Phone', key: 'phone', width: 15 },
  { header: 'Date of Birth (YYYY-MM-DD) *', key: 'dateOfBirth', width: 25 },
  { header: 'Gender (MALE/FEMALE/OTHER)', key: 'gender', width: 25 },
  { header: 'ID Card *', key: 'idCard', width: 20 },
  { header: 'Address', key: 'address', width: 30 },
  { header: 'Department (Code or Name) *', key: 'department', width: 30 },
  { header: 'Position *', key: 'position', width: 20 },
  { header: 'Start Date (YYYY-MM-DD) *', key: 'startDate', width: 25 },
  { header: 'Base Salary *', key: 'baseSalary', width: 20 },
  // Blank means MONTHLY. DAILY makes the Base Salary column a PER-DAY rate.
  { header: 'Pay Basis (MONTHLY/DAILY)', key: 'salaryType', width: 24 },
  { header: 'Timezone', key: 'timezone', width: 20 },
  { header: 'Phone Country (ISO code, e.g. OM)', key: 'phoneCountryCode', width: 30 },
] as const;

/** 1-based index of the last fixed column. Custom columns start at +1. */
export const FIXED_IMPORT_COLUMN_COUNT = FIXED_IMPORT_COLUMNS.length;

/**
 * True when a 1-based worksheet column is beyond the fixed block and may
 * therefore be claimed by a template field matched on header text.
 *
 * A custom field an admin relabelled to "Timezone" must NOT hijack column 13:
 * the positional reader owns that cell and would otherwise read it twice.
 */
export function isCustomImportColumn(colNumber: number): boolean {
  return colNumber > FIXED_IMPORT_COLUMN_COUNT;
}

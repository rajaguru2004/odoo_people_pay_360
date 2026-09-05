/**
 * The Excel import column contract.
 *
 * `previewImport()` reads the fixed block by INDEX and custom template columns
 * by HEADER TEXT. Those two readers have to agree on where the fixed block ends.
 * They once did not — one branch appended `phoneCountryCode` as column 14 while
 * the other still guarded custom columns with `colNumber > 13` — so the first
 * custom column could be read as the phone region with no error raised.
 *
 * These cases pin the boundary from both sides so the two can never drift apart
 * again silently.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  FIXED_IMPORT_COLUMNS,
  FIXED_IMPORT_COLUMN_COUNT,
  isCustomImportColumn,
} from './import-columns';

describe('FIXED_IMPORT_COLUMNS', () => {
  it('is the fourteen-column block the positional reader expects', () => {
    expect(FIXED_IMPORT_COLUMN_COUNT).toBe(14);
    expect(FIXED_IMPORT_COLUMNS).toHaveLength(14);
  });

  it('ends with Phone Country, so template columns start at 15', () => {
    const last = FIXED_IMPORT_COLUMNS[FIXED_IMPORT_COLUMN_COUNT - 1];
    expect(last.key).toBe('phoneCountryCode');
    expect(last.header).toBe('Phone Country (ISO code, e.g. OM)');
  });

  it('lists every key exactly once', () => {
    const keys = FIXED_IMPORT_COLUMNS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('lists every header exactly once', () => {
    // Two identical headers would make header-text matching ambiguous.
    const headers = FIXED_IMPORT_COLUMNS.map((c) => c.header);
    expect(new Set(headers).size).toBe(headers.length);
  });

  it('keys are in the order the positional reader consumes them', () => {
    // Mirrors getCellValue(1..14) in previewImport(). If someone reorders the
    // constant without reordering the reader, this is what goes red.
    expect(FIXED_IMPORT_COLUMNS.map((c) => c.key)).toEqual([
      'fullName',
      'email',
      'phone',
      'dateOfBirth',
      'gender',
      'idCard',
      'address',
      'department',
      'position',
      'startDate',
      'baseSalary',
      'salaryType',
      'timezone',
      'phoneCountryCode',
    ]);
  });
});

describe('isCustomImportColumn', () => {
  it('claims nothing inside the fixed block', () => {
    for (let col = 1; col <= FIXED_IMPORT_COLUMN_COUNT; col++) {
      expect(isCustomImportColumn(col)).toBe(false);
    }
  });

  it('claims the first column after the fixed block', () => {
    expect(isCustomImportColumn(FIXED_IMPORT_COLUMN_COUNT + 1)).toBe(true);
  });

  it('does not let a custom column claim the phone-country cell', () => {
    // The exact regression: column 14 is Phone Country and is read positionally.
    // A template field relabelled to match it must not also bind here.
    expect(isCustomImportColumn(14)).toBe(false);
    expect(isCustomImportColumn(15)).toBe(true);
  });

  it('claims a far-right column, so reordered sheets still match by header', () => {
    expect(isCustomImportColumn(40)).toBe(true);
  });
});

describe('the reader and the writer agree', () => {
  /**
   * Reads the positional indices out of employees.service.ts itself. A source
   * scan is blunt, but the alternative is asserting the boundary only in the
   * constant that defines it, which proves nothing. This fails if someone adds
   * a getCellValue() past the fixed block, or stops reading one inside it.
   */
  const readerIndices = (): number[] => {
    const src = readFileSync(join(__dirname, 'employees.service.ts'), 'utf8');
    const body = src.slice(src.indexOf('async previewImport'));
    const found = new Set<number>();
    for (const m of body.matchAll(/getCellValue\((\d+)\)/g)) {
      found.add(Number(m[1]));
    }
    return [...found].sort((a, b) => a - b);
  };

  it('reads every fixed column by index, and nothing beyond the block', () => {
    const indices = readerIndices();
    expect(indices).toEqual(
      Array.from({ length: FIXED_IMPORT_COLUMN_COUNT }, (_, i) => i + 1),
    );
  });
});

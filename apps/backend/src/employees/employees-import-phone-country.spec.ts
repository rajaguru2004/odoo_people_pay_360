import { Workbook } from 'exceljs';
import { createWriteStream, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { once } from 'events';
import { EmployeesService } from './employees.service';
import { DEFAULT_START_DATE_POLICY } from '../common/utils/start-date-policy.util';

/**
 * Bulk import of the phone country column.
 *
 * previewImport reads cells by INDEX while generateImportTemplate writes them by
 * NAME, so the two are one contract split across a thousand lines. The header
 * list below is pinned against the REAL generated template in the first test, so
 * inserting a column anywhere but the end fails here loudly instead of silently
 * shifting every later field — salaries into the pay-basis column, and so on.
 */
describe('EmployeesService — phone country through bulk import', () => {
  let prisma: any;
  let templates: any;
  let service: EmployeesService;
  let dir: string;
  let seq = 0;

  const DEPARTMENTS = [{ id: 'dept-1', code: 'OPS', name: 'Operations' }];

  /** Column order the parser's getCellValue(n) calls assume. */
  const HEADERS = [
    'Full Name *',
    'Email *',
    'Phone',
    'Date of Birth (YYYY-MM-DD) *',
    'Gender (MALE/FEMALE/OTHER)',
    'ID Card *',
    'Address',
    'Department (Code or Name) *',
    'Position *',
    'Start Date (YYYY-MM-DD) *',
    'Base Salary *',
    'Pay Basis (MONTHLY/DAILY)',
    'Timezone',
    'Phone Country (ISO code, e.g. OM)',
  ];

  const KEYS = [
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
  ];

  /**
   * Turn the template on with the given JSONB fields, as the resolver would
   * report them. Import only ever appends active, non-sensitive JSONB fields.
   */
  const enableTemplate = (
    fields: { fieldKey: string; label: string; required?: boolean }[],
  ) => {
    templates.resolve.mockResolvedValue({
      enabled: true,
      fields: fields.map((f) => ({
        fieldKey: f.fieldKey,
        label: f.label,
        required: f.required ?? false,
        isActive: true,
        storage: 'JSONB',
        isSensitive: false,
        fieldType: 'TEXT',
        validationType: 'NONE',
      })),
    });
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'emp-import-'));
    templates = {
      resolve: jest.fn().mockResolvedValue({ enabled: false, fields: [] }),
    };
    prisma = {
      department: { findMany: jest.fn().mockResolvedValue(DEPARTMENTS) },
      employee: { findMany: jest.fn().mockResolvedValue([]) },
      user: { findMany: jest.fn().mockResolvedValue([]) },
      libraryItem: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    service = new EmployeesService(
      prisma,
      {} as any,
      {} as any,
      // SystemSettingsService — previewImport resolves the start-date policy
      // once per sheet, so this one method has to exist.
      {
        getEmploymentStartDatePolicy: jest
          .fn()
          .mockResolvedValue(DEFAULT_START_DATE_POLICY),
      } as any,
      {} as any,
      { assertCleared: jest.fn() } as any,
      // Profile template resolver. generateImportTemplate() now calls
      // templates.resolve(null) to decide which custom columns to append —
      // a bare {} crashes at runtime even though it typechecks. Default is the
      // kill switch off; `enableTemplate()` below flips it for the cases that
      // need custom columns present.
      templates as any,
      // SupervisorsService — not reached by the import path.
      {
        assign: jest.fn().mockResolvedValue(undefined),
        unassign: jest.fn().mockResolvedValue(undefined),
      } as any,
          // GarnishmentsService — appended to the ctor when court orders became a
      // real model; an exit flips any unrecovered balance to RECEIVABLE.
      { markOutstandingAsReceivable: jest.fn().mockResolvedValue(0) } as any,
);
  });

  /** The header row exactly as the download endpoint produces it. */
  const generatedHeaders = async (): Promise<string[]> => {
    const file = join(dir, `template-${seq++}.xlsx`);
    const stream = createWriteStream(file);
    await service.generateImportTemplate({
      setHeader: () => undefined,
      end: () => stream.end(),
      // exceljs only ever pipes into `res`; the rest is stream plumbing.
      write: (chunk: any, ...rest: any[]) => (stream as any).write(chunk, ...rest),
      on: (...args: any[]) => (stream as any).on(...args),
      once: (...args: any[]) => (stream as any).once(...args),
      emit: (...args: any[]) => (stream as any).emit(...args),
    } as any);
    await once(stream, 'close');

    const wb = new Workbook();
    await wb.xlsx.readFile(file);
    // exceljs does not persist column `key`s through a file, so compare headers.
    const row = wb.worksheets[0].getRow(1).values as any[];
    return row.slice(1).map((v) => String(v));
  };

  /** A sheet in the template's shape, carrying only `rows`. */
  const sheetWith = async (rows: Record<string, any>[]): Promise<string> => {
    const wb = new Workbook();
    const ws = wb.addWorksheet('Employee Template');
    ws.addRow(HEADERS); // row 1 — the parser skips it
    for (const r of rows) ws.addRow(KEYS.map((k) => (k in r ? r[k] : '')));
    const file = join(dir, `import-${seq++}.xlsx`);
    await wb.xlsx.writeFile(file);
    return file;
  };

  const VALID = {
    fullName: 'Ahmed Al Balushi',
    email: 'ahmed@example.com',
    phone: '90010000',
    dateOfBirth: '1990-05-05',
    gender: 'MALE',
    idCard: 'ID-100',
    address: 'Muscat',
    department: 'OPS',
    position: 'Fitter',
    startDate: '2026-06-01',
    baseSalary: 500,
    salaryType: 'MONTHLY',
    timezone: 'Asia/Muscat',
  };

  // previewImport answers the controller's envelope — { success, data: { summary,
  // rows } } — so every assertion below reads the payload, not the wrapper.
  const previewFile = async (path: string) =>
    (await service.previewImport(path)).data;

  const preview = async (rows: Record<string, any>[]) =>
    previewFile(await sheetWith(rows));

  it('appends the phone country column to the real template instead of inserting it', async () => {
    // A sheet downloaded before this change still parses: no existing index moved.
    await expect(generatedHeaders()).resolves.toEqual(HEADERS);
    expect(HEADERS[HEADERS.length - 1]).toMatch(/Phone Country/);
  });

  it('reads the country without disturbing its neighbours', async () => {
    const res = await preview([{ ...VALID, phoneCountryCode: 'OM' }]);
    expect(res.rows[0].errors).toEqual([]);
    expect(res.rows[0].data).toMatchObject({
      // The fields either side of the new column prove nothing shifted.
      salaryType: 'MONTHLY',
      timezone: 'Asia/Muscat',
      phone: '90010000',
      baseSalary: 500,
      phoneCountryCode: 'OM',
    });
  });

  it('canonicalises a lowercase code', async () => {
    const res = await preview([{ ...VALID, phoneCountryCode: 'om' }]);
    expect(res.rows[0].data.phoneCountryCode).toBe('OM');
  });

  it('accepts a blank cell as "not stated"', async () => {
    // Every sheet produced before this column existed lands here.
    const res = await preview([{ ...VALID, phoneCountryCode: '' }]);
    expect(res.rows[0].errors).toEqual([]);
    expect(res.rows[0].valid).toBe(true);
    expect(res.rows[0].data.phoneCountryCode).toBeNull();
  });

  it('rejects a junk code loudly rather than importing a silent null', async () => {
    const res = await preview([{ ...VALID, phoneCountryCode: 'Oman' }]);
    expect(res.rows[0].valid).toBe(false);
    expect(res.rows[0].errors.join(' ')).toMatch(
      /Phone Country "Oman" is not a valid ISO country code/,
    );
  });

  it('fails only the offending row, not the whole sheet', async () => {
    const res = await preview([
      { ...VALID, phoneCountryCode: 'OM' },
      { ...VALID, email: 'b@example.com', idCard: 'ID-101', phoneCountryCode: 'XX' },
      { ...VALID, email: 'c@example.com', idCard: 'ID-102', phoneCountryCode: 'SG' },
    ]);
    expect(res.summary).toMatchObject({ totalRows: 3, validRows: 2, invalidRows: 1 });
    expect(res.rows.map((r: any) => r.data.phoneCountryCode)).toEqual(['OM', null, 'SG']);
  });

  /**
   * The half of the contract that broke on merge. `main` made Phone Country a
   * fixed column read by index; the template branch appended custom columns and
   * skipped "the fixed thirteen". Merged, the fixed block is fourteen wide, so
   * the first custom column sat exactly where the positional reader looks for
   * the region code — no error, just the wrong value in the wrong field.
   */
  describe('with custom template columns appended', () => {
    const CUSTOM = [
      { fieldKey: 'shirtSize', label: 'Shirt Size' },
      { fieldKey: 'bloodGroup', label: 'Blood Group', required: true },
    ];

    /** A sheet with the fixed block plus trailing custom columns. */
    const sheetWithCustom = async (
      row: Record<string, any>,
      customHeaders: string[],
      customValues: any[],
    ): Promise<string> => {
      const wb = new Workbook();
      const ws = wb.addWorksheet('Employee Template');
      ws.addRow([...HEADERS, ...customHeaders]);
      ws.addRow([...KEYS.map((k) => (k in row ? row[k] : '')), ...customValues]);
      const file = join(dir, `import-custom-${seq++}.xlsx`);
      await wb.xlsx.writeFile(file);
      return file;
    };

    it('appends custom columns after the fixed block, leaving it untouched', async () => {
      enableTemplate(CUSTOM);
      const headers = await generatedHeaders();
      expect(headers.slice(0, HEADERS.length)).toEqual(HEADERS);
      expect(headers.slice(HEADERS.length)).toEqual([
        'Shirt Size',
        'Blood Group *',
      ]);
    });

    it('still reads phone country from column 14, not from a custom column', async () => {
      enableTemplate(CUSTOM);
      const res = await previewFile(
        await sheetWithCustom(
          { ...VALID, phoneCountryCode: 'OM' },
          ['Shirt Size', 'Blood Group *'],
          ['L', 'O+'],
        ),
      );
      expect(res.rows[0].errors).toEqual([]);
      expect(res.rows[0].data.phoneCountryCode).toBe('OM');
      expect(res.rows[0].data.customFields).toMatchObject({
        shirtSize: 'L',
        bloodGroup: 'O+',
      });
    });

    it('will not let a custom field relabelled to a fixed header hijack its column', async () => {
      // An admin is free to name a field "Timezone". The positional reader owns
      // column 13 regardless, and the custom field simply never binds.
      enableTemplate([{ fieldKey: 'tzNote', label: 'Timezone' }]);
      const res = await previewFile(
        await sheetWith([{ ...VALID, phoneCountryCode: 'OM' }]),
      );
      expect(res.rows[0].data.timezone).toBe('Asia/Muscat');
      expect(res.rows[0].data.phoneCountryCode).toBe('OM');
      expect(res.rows[0].data.customFields?.tzNote).toBeUndefined();
    });

    it('imports a sheet that has only the fixed columns while the flag is on', async () => {
      // Backward compatibility for every template already downloaded. The
      // required custom field must not block a file that predates it.
      enableTemplate(CUSTOM);
      const res = await previewFile(
        await sheetWith([{ ...VALID, phoneCountryCode: 'SG' }]),
      );
      expect(res.rows[0].data.phoneCountryCode).toBe('SG');
      expect(res.rows[0].data.timezone).toBe('Asia/Muscat');
    });

    it('binds a custom column by header text even when it is far to the right', async () => {
      enableTemplate([{ fieldKey: 'shirtSize', label: 'Shirt Size' }]);
      const res = await previewFile(
        await sheetWithCustom(
          { ...VALID, phoneCountryCode: 'OM' },
          ['Filler A', 'Filler B', 'Shirt Size'],
          ['', '', 'XL'],
        ),
      );
      expect(res.rows[0].data.phoneCountryCode).toBe('OM');
      expect(res.rows[0].data.customFields).toMatchObject({ shirtSize: 'XL' });
    });
  });
});

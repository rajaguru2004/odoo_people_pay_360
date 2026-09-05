import { Workbook } from 'exceljs';
import { createWriteStream, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { once } from 'events';
import { EmployeesService } from './employees.service';
import {
  DEFAULT_START_DATE_POLICY,
  StartDatePolicy,
  checkEmploymentStartDate,
} from '../common/utils/start-date-policy.util';

/**
 * Start-date policy through bulk import.
 *
 * The import used to carry its own copy of the "1 year in the past" rule, so it
 * could drift from EmployeesService.create(). Both now call the same helper
 * with the same policy object, and the policy is resolved ONCE per sheet —
 * previewImport's row loop is a synchronous exceljs callback and cannot await.
 */
describe('EmployeesService — start date through bulk import', () => {
  let prisma: any;
  let settings: { getEmploymentStartDatePolicy: jest.Mock };
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

  const daysFromToday = (days: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().split('T')[0];
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'emp-start-date-'));
    prisma = {
      department: { findMany: jest.fn().mockResolvedValue(DEPARTMENTS) },
      employee: { findMany: jest.fn().mockResolvedValue([]) },
      user: { findMany: jest.fn().mockResolvedValue([]) },
      libraryItem: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    settings = {
      getEmploymentStartDatePolicy: jest
        .fn()
        .mockResolvedValue(DEFAULT_START_DATE_POLICY),
    };
    service = new EmployeesService(
      prisma,
      {} as any,
      {} as any,
      settings as any,
      {} as any,
      { assertCleared: jest.fn() } as any,
      {} as any,
      {} as any,
      // Profile template resolver. generateImportTemplate() and previewImport()
      // both call templates.resolve(null) to decide which custom columns exist,
      // so a bare {} throws at runtime even though it typechecks. The kill
      // switch is off here — these cases are about start dates, not templates.
      {
        resolve: jest.fn().mockResolvedValue({ enabled: false, fields: [] }),
      } as any,
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

  const withPolicy = (over: Partial<StartDatePolicy>) =>
    settings.getEmploymentStartDatePolicy.mockResolvedValue({
      ...DEFAULT_START_DATE_POLICY,
      ...over,
    });

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
    startDate: daysFromToday(-30),
    baseSalary: 500,
    salaryType: 'MONTHLY',
    timezone: 'Asia/Muscat',
  };

  // previewImport answers the controller's envelope — { success, data: { summary,
  // rows } } — so every assertion below reads the payload, not the wrapper.
  const preview = async (rows: Record<string, any>[]) =>
    (await service.previewImport(await sheetWith(rows))).data;

  const other = (n: number, over: Record<string, any> = {}) => ({
    ...VALID,
    email: `person${n}@example.com`,
    idCard: `ID-${100 + n}`,
    ...over,
  });

  it('accepts a row backdated by years', async () => {
    const res = await preview([{ ...VALID, startDate: '2019-04-01' }]);
    expect(res.rows[0].errors).toEqual([]);
    expect(res.rows[0].valid).toBe(true);
    expect(res.rows[0].data.startDate).toBe('2019-04-01');
  });

  it('enforces a configured past window with the helper\'s own message', async () => {
    withPolicy({ maxPastDays: 365 });
    const startDate = daysFromToday(-800);
    const expected = checkEmploymentStartDate({
      startDate,
      dateOfBirth: VALID.dateOfBirth,
      policy: { ...DEFAULT_START_DATE_POLICY, maxPastDays: 365 },
    });

    const res = await preview([{ ...VALID, startDate }]);
    expect(res.rows[0].valid).toBe(false);
    expect(res.rows[0].errors).toContain(
      expected.ok === false ? expected.message : '',
    );
  });

  it('rejects a start date before the date of birth', async () => {
    const res = await preview([
      { ...VALID, dateOfBirth: '1990-05-05', startDate: '1989-01-01' },
    ]);
    expect(res.rows[0].valid).toBe(false);
    expect(res.rows[0].errors.join(' ')).toMatch(/before the date of birth/);
  });

  it('rejects a far-future start date', async () => {
    const res = await preview([{ ...VALID, startDate: daysFromToday(730) }]);
    expect(res.rows[0].valid).toBe(false);
    expect(res.rows[0].errors.join(' ')).toMatch(/days in the future/);
  });

  it('rejects an unparseable start date and stores null', async () => {
    const res = await preview([{ ...VALID, startDate: 'not-a-date' }]);
    expect(res.rows[0].valid).toBe(false);
    expect(res.rows[0].data.startDate).toBeNull();
  });

  it('keeps the specific wording for a blank cell', async () => {
    const res = await preview([{ ...VALID, startDate: '' }]);
    expect(res.rows[0].errors).toContain('Start Date is required');
  });

  it('fails only the offending row', async () => {
    withPolicy({ maxPastDays: 365 });
    const res = await preview([
      other(1, { startDate: daysFromToday(-200) }),
      other(2, { startDate: daysFromToday(-900) }),
      other(3, { startDate: daysFromToday(-10) }),
    ]);
    expect(res.summary).toMatchObject({
      totalRows: 3,
      validRows: 2,
      invalidRows: 1,
    });
  });

  it('resolves the policy once per sheet, not once per row', async () => {
    // The row loop is a synchronous exceljs callback: a per-row await would not
    // even compile, and a per-row lookup would hammer the settings table.
    await preview([other(1), other(2), other(3), other(4), other(5)]);
    expect(settings.getEmploymentStartDatePolicy).toHaveBeenCalledTimes(1);
  });

  describe('the shipped template', () => {
    /** The template exactly as the download endpoint produces it. */
    const templateRows = async () => {
      const file = join(dir, `template-${seq++}.xlsx`);
      const stream = createWriteStream(file);
      await service.generateImportTemplate({
        setHeader: () => undefined,
        end: () => stream.end(),
        write: (chunk: any, ...rest: any[]) =>
          (stream as any).write(chunk, ...rest),
        on: (...args: any[]) => (stream as any).on(...args),
        once: (...args: any[]) => (stream as any).once(...args),
        emit: (...args: any[]) => (stream as any).emit(...args),
      } as any);
      await once(stream, 'close');

      const wb = new Workbook();
      await wb.xlsx.readFile(file);
      const ws = wb.worksheets[0];
      const startCol = HEADERS.indexOf('Start Date (YYYY-MM-DD) *') + 1;
      const dobCol = HEADERS.indexOf('Date of Birth (YYYY-MM-DD) *') + 1;

      const rows: { startDate: string; dateOfBirth: string }[] = [];
      ws.eachRow((row, n) => {
        if (n === 1) return;
        rows.push({
          startDate: String(row.getCell(startCol).value ?? ''),
          dateOfBirth: String(row.getCell(dobCol).value ?? ''),
        });
      });
      return rows;
    };

    it('ships sample rows that pass its own import, even under a tight window', async () => {
      const rows = await templateRows();
      expect(rows.length).toBeGreaterThan(0);

      for (const row of rows) {
        for (const maxPastDays of [null, 365]) {
          const res = checkEmploymentStartDate({
            startDate: row.startDate,
            dateOfBirth: row.dateOfBirth,
            policy: { ...DEFAULT_START_DATE_POLICY, maxPastDays },
          });
          expect(res.ok).toBe(true);
        }
      }
    });
  });
});

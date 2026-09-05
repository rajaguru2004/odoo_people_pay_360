import { OmanCboFormat } from './oman-cbo.format';
import { WpsRunPayload, WpsEmployeeRow } from '../types/wps-payload';
import { WpsMoney, sumMinor, toMinor } from '../wps-money.util';

/**
 * Byte-exact golden test for the Oman wage file.
 *
 * A wage file is POSITIONAL: a one-column shift is invisible to any assertion that
 * parses the output back into fields, but fatal to the bank. So the expected bytes
 * are written out literally, CRLF included, and compared with Buffer.compare.
 *
 * The layout itself is provisional until the sponsoring bank supplies its spec —
 * see the header of oman-cbo.format.ts. When it lands, this fixture changes with
 * the adapter, and the diff is the whole review.
 */
describe('OmanCboFormat', () => {
  const format = new OmanCboFormat();
  const CUR = 'OMR';
  const EXP = 3;

  const money = (v: string): WpsMoney => toMinor(v, CUR, EXP, 'test');

  const row = (over: Partial<WpsEmployeeRow> = {}): WpsEmployeeRow => {
    const basic = over.basic ?? money('288.000');
    const allowances = over.allowances ?? money('205.180');
    const deductions = over.deductions ?? money('3.700');
    const net =
      over.net ??
      ({
        minor: basic.minor + allowances.minor - deductions.minor,
        currency: CUR,
        exponent: EXP,
      } as WpsMoney);
    return {
      employeeId: 'e1',
      payrollItemId: 'i1',
      employeeCode: 'SMP-EMP-019',
      fullName: 'Ahmed Al-Habsi',
      identifiers: {},
      startDate: new Date('2015-01-01T00:00:00Z'),
      endDate: null,
      salaryType: 'MONTHLY',
      nationality: 'Oman',
      bank: {
        bankId: 'b1',
        bankName: 'Bank Dhofar',
        bankCode: '029',
        swift: null,
        country: 'OM',
        fields: {},
        iban: 'OM450291000000000142542',
        accountNumber: null,
        accountHolderName: 'Ahmed Al-Habsi',
        bankDetailId: 'bd1',
      },
      basic,
      allowances,
      deductions,
      net,
      gross: { minor: basic.minor + allowances.minor, currency: CUR, exponent: EXP },
      workDays: 22,
      actualWorkDays: 22,
      lopDays: 0,
      extra: {},
      ...over,
    };
  };

  const payload = (rows: WpsEmployeeRow[], over: Partial<WpsRunPayload> = {}): WpsRunPayload => ({
    runId: 'run-1',
    version: 1,
    format: format.key,
    specVersion: format.specVersion,
    branch: { id: 'br1', code: 'SMP-MCT', name: 'Muscat Branch', country: 'OM' },
    employer: {
      legalName: 'The Company LLC',
      country: 'OM',
      data: {
        molEstablishmentNumber: '1234567',
        crNumber: '1010101',
        employerBankCode: '018',
        employerAccountIban: 'OM810180000001299123456',
      },
    },
    period: {
      month: 8,
      year: 2026,
      startDate: new Date('2026-08-01T00:00:00Z'),
      endDate: new Date('2026-08-31T00:00:00Z'),
    },
    paymentDate: new Date('2026-08-31T00:00:00Z'),
    payroll: {
      id: 'p1',
      version: 1,
      lockedAt: new Date('2026-08-31T10:00:00Z'),
      approvedAt: new Date('2026-08-31T09:00:00Z'),
    },
    rows,
    total: sumMinor(rows.map((r) => r.net), CUR, EXP),
    currency: CUR,
    currencyExponent: EXP,
    runOptions: { purposeCode: 'SAL' },
    generatedAt: new Date('2026-08-31T11:00:00Z'),
    generatedBy: { userId: 'u1', name: 'Admin' },
    ...over,
  });

  describe('generate — golden bytes', () => {
    it('produces the exact expected file for a two-employee run', async () => {
      const rows = [
        row(),
        row({
          employeeId: 'e2',
          employeeCode: 'SMP-EMP-020',
          fullName: 'Fatima Al-Balushi',
          basic: money('372.000'),
          allowances: money('268.850'),
          deductions: money('49.450'),
          net: money('591.400'),
          bank: {
            ...row().bank,
            bankName: 'Bank Muscat',
            bankCode: '018',
            iban: 'OM040181000000000150461',
            accountHolderName: 'Fatima Al-Balushi',
          },
        }),
      ];

      const [artifact] = await format.generate(payload(rows));

      const expected =
        '01,1234567,1010101,The Company LLC,018,OM810180000001299123456,202608,20260831,OMR,SAL,2,000001080880\r\n' +
        '02,1,SMP-EMP-019,,,Ahmed Al-Habsi,029,OM450291000000000142542,000000288000,000000205180,000000003700,000000489480,22,0\r\n' +
        '02,2,SMP-EMP-020,,,Fatima Al-Balushi,018,OM040181000000000150461,000000372000,000000268850,000000049450,000000591400,22,0\r\n' +
        '09,2,000001080880,0001080880\r\n';

      expect(artifact.bytes.toString('latin1')).toBe(expected);
      expect(Buffer.compare(artifact.bytes, Buffer.from(expected, 'latin1'))).toBe(0);
      expect(artifact.role).toBe('PRIMARY');
      expect(artifact.mimeType).toBe('text/plain');
      expect(artifact.fileName).toBe('WPS_OM_1234567_202608_v1.txt');
    });

    it('header total equals the sum of the detail rows', async () => {
      const rows = [row(), row({ employeeId: 'e2', net: money('591.400') })];
      const [artifact] = await format.generate(payload(rows));
      const lines = artifact.bytes.toString('latin1').trim().split('\r\n');

      const headerTotal = BigInt(lines[0].split(',')[11]);
      const detailSum = lines
        .filter((l) => l.startsWith('02,'))
        .reduce((acc, l) => acc + BigInt(l.split(',')[11]), 0n);
      const trailerTotal = BigInt(lines[lines.length - 1].split(',')[2]);

      // The invariant a bank validator recomputes.
      expect(detailSum).toBe(headerTotal);
      expect(trailerTotal).toBe(headerTotal);
    });

    it('writes CRLF line endings and a trailing terminator', async () => {
      const [artifact] = await format.generate(payload([row()]));
      const text = artifact.bytes.toString('latin1');
      expect(text.endsWith('\r\n')).toBe(true);
      // No bare LF anywhere.
      expect(text.replace(/\r\n/g, '')).not.toContain('\n');
    });

    it('emits amounts in baisa — 3 decimals, not 2', async () => {
      const [artifact] = await format.generate(
        payload([row({ net: money('1.234'), basic: money('1.234'), allowances: money('0'), deductions: money('0') })]),
      );
      const detail = artifact.bytes.toString('latin1').split('\r\n')[1].split(',');
      expect(detail[11]).toBe('000000001234'); // 1234 baisa = OMR 1.234
    });

    it('folds a diacritic name to ASCII so byte length matches column count', async () => {
      const [artifact] = await format.generate(
        payload([row({ fullName: 'Zoë Müller', bank: { ...row().bank, accountHolderName: 'Zoë Müller' } })]),
      );
      const detail = artifact.bytes.toString('latin1').split('\r\n')[1];
      expect(detail).toContain('Zoe Muller');
      expect(detail.split(',')).toHaveLength(14);
    });

    it('strips a comma from a name rather than shifting every later column', async () => {
      const [artifact] = await format.generate(
        payload([
          row({
            fullName: 'Smith, John',
            bank: { ...row().bank, accountHolderName: 'Smith, John' },
          }),
        ]),
      );
      const detail = artifact.bytes.toString('latin1').split('\r\n')[1];
      expect(detail.split(',')).toHaveLength(14);
      expect(detail).toContain('Smith John');
    });

    it('includes labour card and civil ID when present', async () => {
      const [artifact] = await format.generate(
        payload([
          row({
            identifiers: {
              LABOUR_CARD: { number: 'LC-99887', expiryDate: new Date('2030-01-01T00:00:00Z') },
              CIVIL_ID: { number: 'CID-12345', expiryDate: null },
            },
          }),
        ]),
      );
      const detail = artifact.bytes.toString('latin1').split('\r\n')[1].split(',');
      expect(detail[3]).toBe('LC-99887');
      expect(detail[4]).toBe('CID-12345');
    });

    it('names a corrected file v2 so it cannot overwrite v1 on disk', async () => {
      const [artifact] = await format.generate(payload([row()], { version: 2 }));
      expect(artifact.fileName).toBe('WPS_OM_1234567_202608_v2.txt');
    });
  });

  describe('validate', () => {
    it('passes a clean payload', () => {
      expect(format.validate(payload([row()]))).toEqual([]);
    });

    it('blocks a bank with no CBO code — the payment cannot be routed', () => {
      const findings = format.validate(
        payload([row({ bank: { ...row().bank, bankCode: null } })]),
      );
      expect(findings.map((f) => f.code)).toContain('BANK_CODE_UNKNOWN');
      expect(findings.find((f) => f.code === 'BANK_CODE_UNKNOWN')!.severity).toBe('BLOCKING');
    });

    it('blocks an IBAN whose embedded bank code contradicts the selected bank', () => {
      const findings = format.validate(
        payload([
          row({
            bank: {
              ...row().bank,
              bankCode: '018',
              iban: 'OM450291000000000142542', // carries 029
            },
          }),
        ]),
      );
      const f = findings.find((x) => x.code === 'IBAN_INVALID');
      expect(f?.severity).toBe('BLOCKING');
      expect(f?.message).toMatch(/bank code/i);
    });

    it('blocks a mistyped IBAN via the mod-97 checksum', () => {
      const findings = format.validate(
        payload([
          row({ bank: { ...row().bank, bankCode: '029', iban: 'OM450291000000000142543' } }),
        ]),
      );
      expect(findings.find((f) => f.code === 'IBAN_INVALID')?.message).toMatch(
        /check digits/i,
      );
    });

    it('blocks an invalid employer salary account', () => {
      const p = payload([row()]);
      p.employer.data.employerAccountIban = 'OM810180000001299123450'; // bad checksum
      expect(format.validate(p).map((f) => f.code)).toContain('EMPLOYER_ACCOUNT_INVALID');
    });

    it('blocks an employer bank code that is not 3 digits', () => {
      const p = payload([row()]);
      p.employer.data.employerBankCode = '18';
      expect(format.validate(p).map((f) => f.code)).toContain('EMPLOYER_BANK_CODE_INVALID');
    });

    it('blocks a payment date before the period ends', () => {
      const p = payload([row()], { paymentDate: new Date('2026-08-15T00:00:00Z') });
      expect(format.validate(p).map((f) => f.code)).toContain(
        'PAYMENT_DATE_BEFORE_PERIOD_END',
      );
    });

    it('warns when payment is more than a week after the period ends', () => {
      const p = payload([row()], { paymentDate: new Date('2026-09-20T00:00:00Z') });
      const f = p && format.validate(p).find((x) => x.code === 'PAYMENT_DATE_LATE');
      expect(f?.severity).toBe('WARNING');
    });

    it('blocks an amount that will not fit the fixed-width field', () => {
      const findings = format.validate(
        payload([row({ net: { minor: 10n ** 13n, currency: CUR, exponent: EXP } })]),
      );
      expect(findings.map((f) => f.code)).toContain('AMOUNT_TOO_LARGE');
    });

    it('warns, not blocks, when the account holder name is missing', () => {
      const findings = format.validate(
        payload([row({ bank: { ...row().bank, accountHolderName: null } })]),
      );
      const f = findings.find((x) => x.code === 'ACCOUNT_HOLDER_MISSING');
      expect(f?.severity).toBe('WARNING');
    });

    it('never throws for a data problem — findings are the contract', () => {
      // An adapter that throws on bad data would crash the pre-flight screen.
      const broken = payload([
        row({ bank: { ...row().bank, bankCode: null, iban: null, accountHolderName: null } }),
      ]);
      expect(() => format.validate(broken)).not.toThrow();
    });
  });

  describe('declared contract', () => {
    it('is Oman, OMR, 3 decimals', () => {
      expect(format.country).toBe('OM');
      expect(format.currency).toBe('OMR');
      expect(format.currencyExponent).toBe(3);
    });

    it('marks the spec as provisional until the bank confirms it', () => {
      expect(format.specVersion).toMatch(/PROVISIONAL/);
    });

    it('requires the employer fields the file header carries', () => {
      expect(format.employerConfigSchema.filter((f) => f.required).map((f) => f.name)).toEqual(
        expect.arrayContaining([
          'molEstablishmentNumber',
          'crNumber',
          'employerBankCode',
          'employerAccountIban',
        ]),
      );
    });

    it('asks for the labour card and civil ID', () => {
      expect(format.requiredIdentifiers.map((r) => r.category)).toEqual(
        expect.arrayContaining(['LABOUR_CARD', 'CIVIL_ID']),
      );
    });
  });
});

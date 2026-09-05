import { OmanSifEdrFormat } from './oman-sif-edr.format';
import { WpsEmployeeRow, WpsRunPayload } from '../types/wps-payload';
import { WpsMoney, sumMinor, toMinor } from '../wps-money.util';

/**
 * Byte-exact golden test for the EDR/SCR Oman variant.
 *
 * Same reasoning as the om-cbo golden file: the layout is positional, so an
 * assertion that parses the output back into fields cannot see a shifted column.
 * The expected bytes are written out literally.
 */
describe('OmanSifEdrFormat', () => {
  const format = new OmanSifEdrFormat();
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
      identifiers: { CIVIL_ID: { number: '12345678', expiryDate: null } },
      startDate: new Date('2015-01-01T00:00:00Z'),
      endDate: null,
      salaryType: 'MONTHLY',
      nationality: 'Oman',
      bank: {
        bankId: 'b1',
        bankName: 'Bank Dhofar',
        bankCode: '029',
        swift: 'BDOFOMRX',
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

  const payload = (
    rows: WpsEmployeeRow[],
    over: Partial<WpsRunPayload> = {},
  ): WpsRunPayload => ({
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
    runOptions: {},
    generatedAt: new Date('2026-08-31T10:10:00Z'),
    generatedBy: { userId: 'u1', name: 'Admin' },
    ...over,
  });

  it('produces the exact expected EDR/SCR file', async () => {
    const rows = [
      row(),
      row({
        employeeId: 'e2',
        employeeCode: 'SMP-EMP-020',
        fullName: 'Fatima Al-Balushi',
        identifiers: { CIVIL_ID: { number: '87654321', expiryDate: null } },
        basic: money('372.000'),
        allowances: money('268.850'),
        deductions: money('49.450'),
        net: money('591.400'),
        bank: {
          ...row().bank,
          bankName: 'Bank Muscat',
          bankCode: '018',
          swift: 'BMUSOMRX',
          iban: 'OM040181000000000150461',
          accountHolderName: 'Fatima Al-Balushi',
        },
      }),
    ];

    const [artifact] = await format.generate(payload(rows));

    const expected =
      'EDR,12345678,BDOFOMRX,OM450291000000000142542,Ahmed Al-Habsi,288.000,205.180,3.700,M,082026,1,Salary 08/2026\r\n' +
      'EDR,87654321,BMUSOMRX,OM040181000000000150461,Fatima Al-Balushi,372.000,268.850,49.450,M,082026,1,Salary 08/2026\r\n' +
      'SCR,1234567,OM810180000001299123456,20260831,1010,082026,2,1080.880,OMR,Salary 08/2026\r\n';

    expect(artifact.bytes.toString('latin1')).toBe(expected);
    expect(Buffer.compare(artifact.bytes, Buffer.from(expected, 'latin1'))).toBe(0);
    expect(artifact.fileName).toBe('12345672608311010_v1.SIF');
  });

  it('writes amounts as decimals to exactly 3 places, not padded integers', async () => {
    const [artifact] = await format.generate(
      payload([
        row({
          basic: money('1.234'),
          allowances: money('0'),
          deductions: money('0'),
          net: money('1.234'),
        }),
      ]),
    );
    const edr = artifact.bytes.toString('latin1').split('\r\n')[0].split(',');
    expect(edr[5]).toBe('1.234');
    expect(edr[6]).toBe('0.000'); // zero still carries all 3 places
    expect(edr[7]).toBe('0.000');
  });

  it('SCR total equals the sum of the EDR net values', async () => {
    // The arithmetic a bank validator recomputes — and the exact thing that must
    // not lose a decimal place. Six real rows, whose nets sum to 7332.300.
    const nets = ['489.480', '591.400', '1280.300', '1528.450', '1546.440', '1896.230'];
    const rows = nets.map((n, i) =>
      row({
        employeeId: `e${i}`,
        employeeCode: `SMP-EMP-0${19 + i}`,
        identifiers: { CIVIL_ID: { number: `1000000${i}`, expiryDate: null } },
        basic: money(n),
        allowances: money('0'),
        deductions: money('0'),
        net: money(n),
      }),
    );

    const [artifact] = await format.generate(payload(rows));
    const lines = artifact.bytes.toString('latin1').trim().split('\r\n');
    const scr = lines[lines.length - 1].split(',');

    expect(scr[0]).toBe('SCR');
    expect(scr[6]).toBe('6'); // employee count
    expect(scr[7]).toBe('7332.300'); // NOT 733.230 — a shifted decimal is a rejected file
    expect(scr[8]).toBe('OMR');

    const edrSum = lines
      .filter((l) => l.startsWith('EDR,'))
      .reduce((acc, l) => acc + Number(l.split(',')[5]), 0);
    expect(edrSum.toFixed(3)).toBe(scr[7]);
  });

  it('puts every EDR before the single SCR, and ends with CRLF', async () => {
    const [artifact] = await format.generate(payload([row(), row({ employeeId: 'e2' })]));
    const text = artifact.bytes.toString('latin1');
    const lines = text.trim().split('\r\n');

    expect(lines.filter((l) => l.startsWith('EDR,'))).toHaveLength(2);
    expect(lines.filter((l) => l.startsWith('SCR,'))).toHaveLength(1);
    expect(lines[lines.length - 1].startsWith('SCR,')).toBe(true);
    expect(text.endsWith('\r\n')).toBe(true);
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('honours the frequency, payment-type and description run options', async () => {
    const [artifact] = await format.generate(
      payload([row()], {
        runOptions: { frequency: 'W', paymentType: '3', description: 'Final settlement' },
      }),
    );
    const lines = artifact.bytes.toString('latin1').trim().split('\r\n');
    const edr = lines[0].split(',');
    expect(edr[8]).toBe('W');
    expect(edr[10]).toBe('3');
    expect(edr[11]).toBe('Final settlement');
    expect(lines[1].split(',')[9]).toBe('Final settlement');
  });

  it('blocks a missing civil ID — it is the identifier column in this layout', () => {
    // Contrast om-cbo-v1, where the identifier columns are supplementary and this
    // is only a warning.
    const civilId = format.requiredIdentifiers.find((r) => r.category === 'CIVIL_ID');
    expect(civilId?.severity).toBe('BLOCKING');
  });

  it('blocks a bank with neither BIC nor CBO code — the EDR cannot be routed', () => {
    const findings = format.validate(
      payload([row({ bank: { ...row().bank, swift: null, bankCode: null } })]),
    );
    expect(findings.map((f) => f.code)).toContain('BANK_CODE_UNKNOWN');
  });

  it('blocks a mistyped IBAN via the mod-97 checksum', () => {
    const findings = format.validate(
      payload([row({ bank: { ...row().bank, iban: 'OM450291000000000142543' } })]),
    );
    expect(findings.find((f) => f.code === 'IBAN_INVALID')?.message).toMatch(
      /check digits/i,
    );
  });

  it('folds a diacritic name so byte length matches column count', async () => {
    const [artifact] = await format.generate(
      payload([
        row({
          fullName: 'Zoë Müller',
          bank: { ...row().bank, accountHolderName: 'Zoë Müller' },
        }),
      ]),
    );
    const edr = artifact.bytes.toString('latin1').split('\r\n')[0];
    expect(edr).toContain('Zoe Muller');
    expect(edr.split(',')).toHaveLength(12);
  });

  it('is declared provisional, like the other Oman candidate', () => {
    expect(format.country).toBe('OM');
    expect(format.currencyExponent).toBe(3);
    expect(format.specVersion).toMatch(/PROVISIONAL/);
  });
});

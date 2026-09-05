import { Injectable } from '@nestjs/common';
import { DynamicConfigField } from '../../common/config-schema/dynamic-config-field';
import { IBAN_COUNTRY_RULES, validateIban } from '../../bank-details/iban.util';
import {
  WpsArtifact,
  WpsFormat,
  WpsIdentifierRequirement,
} from '../types/wps-format.interface';
import { WpsFinding } from '../types/wps-finding';
import { WpsRunPayload, optRun } from '../types/wps-payload';
import { minorToPadded, minorToFixed } from '../wps-money.util';

/**
 * Oman — Wage Protection System salary information file (CBO / MoL scheme).
 *
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │ ⚠ THE EXACT LAYOUT IS PROVISIONAL.                                          │
 * │                                                                             │
 * │ The Central Bank sets the WPS layout, each bank distributes its own variant, │
 * │ and it changes over time — so the authoritative spec must come from the      │
 * │ customer's sponsoring bank, not from us. Until that document is in hand,     │
 * │ the record layout below is a faithful implementation of the common GCC SIF   │
 * │ shape (header / detail / trailer, CRLF, minor-unit integer amounts) but the  │
 * │ field ORDER and NAMES are not bank-confirmed.                               │
 * │                                                                             │
 * │ `specVersion` says PROVISIONAL for exactly this reason: every file we        │
 * │ generate records which layout produced it, so files written before the real  │
 * │ spec arrives are identifiable afterwards.                                   │
 * │                                                                             │
 * │ When the spec lands, only this file changes. Everything the flow depends on  │
 * │ — pre-flight, versioning, storage, download, audit — is format-agnostic.     │
 * │ The file must then be accepted by the bank's TEST PORTAL before this is      │
 * │ called finished: our own tests cannot verify a spec we did not write.        │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *
 * Amounts are integer BAISA (OMR exponent 3). This is the whole reason the money
 * path uses minor units: a 2-decimal Omani file disagrees with the bank's own
 * arithmetic, and a total mismatch is what gets a submission rejected.
 */
@Injectable()
export class OmanCboFormat implements WpsFormat {
  readonly key = 'om-cbo-v1';
  readonly displayName = 'Oman WPS — CBO salary file (provisional)';
  readonly description =
    'Wage Protection System file for Omani employers. Amounts in baisa (3 decimals). ' +
    'Layout is provisional until the sponsoring bank supplies its current specification — ' +
    'confirm against the bank test portal before submitting a real payroll.';

  readonly country = 'OM';
  readonly currency = 'OMR';
  readonly currencyExponent = 3;
  readonly specVersion = 'OM-CBO-SIF/PROVISIONAL-2026-08';

  /** Line ending: banks universally expect CRLF in fixed-record text files. */
  private static readonly EOL = '\r\n';

  /** Amount field width in baisa digits — 12 covers OMR 999,999,999.999. */
  private static readonly AMOUNT_WIDTH = 12;

  readonly employerConfigSchema: DynamicConfigField[] = [
    {
      name: 'molEstablishmentNumber',
      label: 'Ministry of Labour establishment number',
      type: 'text',
      required: true,
      help: 'The employer registration the Ministry knows you by. Appears in the file header.',
      placeholder: 'e.g. 1234567',
    },
    {
      name: 'crNumber',
      label: 'Commercial registration (CR) number',
      type: 'text',
      required: true,
      help: 'Company registration number from the Ministry of Commerce.',
      placeholder: 'e.g. 1010101',
    },
    {
      name: 'employerBankCode',
      label: 'Employer bank code (CBO, 3 digits)',
      type: 'text',
      required: true,
      help: 'The 3-digit CBO code of the bank holding the salary account — must match the IBAN below.',
      placeholder: 'e.g. 018',
    },
    {
      name: 'employerAccountIban',
      label: 'Employer salary account IBAN',
      type: 'text',
      required: true,
      help: 'The Omani account salaries are debited from. 23 characters.',
      placeholder: 'OM…',
    },
  ];

  readonly runOptionsSchema: DynamicConfigField[] = [
    {
      name: 'paymentDate',
      label: 'Payment date',
      type: 'text',
      required: false,
      help: 'YYYY-MM-DD. Defaults to the last day of the payroll period.',
      placeholder: 'YYYY-MM-DD',
    },
    {
      name: 'purposeCode',
      label: 'Purpose code',
      type: 'select',
      required: false,
      default: 'SAL',
      options: [
        { value: 'SAL', label: 'SAL — monthly salary' },
        { value: 'ARR', label: 'ARR — arrears / back pay' },
        { value: 'FNL', label: 'FNL — final settlement' },
      ],
      help: 'Why the bank is being asked to pay. Most runs are SAL.',
    },
  ];

  /**
   * Identifiers.
   *
   * Declared WARNING, not BLOCKING, because we cannot yet confirm from the bank's
   * spec which identifier column is mandatory. The pre-flight still surfaces the
   * gap loudly and requires an explicit acknowledgement before generating, so it
   * cannot pass unnoticed.
   *
   * When the spec confirms it (the labour card almost certainly is mandatory),
   * change `severity` to 'BLOCKING' here — that is the entire change.
   */
  readonly requiredIdentifiers: WpsIdentifierRequirement[] = [
    {
      category: 'LABOUR_CARD',
      label: 'Labour card',
      severity: 'WARNING',
      mustBeUnexpired: true,
    },
    {
      category: 'CIVIL_ID',
      label: 'Civil ID',
      severity: 'WARNING',
    },
  ];

  validate(payload: WpsRunPayload): WpsFinding[] {
    const findings: WpsFinding[] = [];
    const emp = payload.employer.data ?? {};

    // ── Employer ────────────────────────────────────────────────────────────
    const employerIban = (emp.employerAccountIban || '').trim();
    const employerBankCode = (emp.employerBankCode || '').trim();

    if (employerIban) {
      const res = validateIban(employerIban, 'OM', employerBankCode || null);
      if (!res.valid) {
        findings.push({
          code: 'EMPLOYER_ACCOUNT_INVALID',
          severity: 'BLOCKING',
          scope: 'EMPLOYER',
          field: 'employerAccountIban',
          message: `Employer salary account is not a valid Omani IBAN: ${res.message}`,
        });
      }
    }

    if (employerBankCode && !/^\d{3}$/.test(employerBankCode)) {
      findings.push({
        code: 'EMPLOYER_BANK_CODE_INVALID',
        severity: 'BLOCKING',
        scope: 'EMPLOYER',
        field: 'employerBankCode',
        message: `Employer bank code must be exactly 3 digits (got '${employerBankCode}').`,
      });
    }

    if (emp.molEstablishmentNumber && !/^[A-Za-z0-9/-]{1,20}$/.test(emp.molEstablishmentNumber)) {
      findings.push({
        code: 'EMPLOYER_MOL_INVALID',
        severity: 'BLOCKING',
        scope: 'EMPLOYER',
        field: 'molEstablishmentNumber',
        message: 'Ministry of Labour establishment number contains unsupported characters.',
      });
    }

    // ── Payment date window ─────────────────────────────────────────────────
    // Oman requires wages within a defined window of the period end. The exact
    // number of days is a legal question flagged for the advisor; a payment date
    // BEFORE the period ends is unambiguously wrong, so that one blocks.
    if (payload.paymentDate < payload.period.endDate) {
      findings.push({
        code: 'PAYMENT_DATE_BEFORE_PERIOD_END',
        severity: 'BLOCKING',
        scope: 'RUN',
        field: 'paymentDate',
        message: `Payment date ${iso(payload.paymentDate)} is before the period ends (${iso(payload.period.endDate)}).`,
      });
    } else {
      const days = Math.floor(
        (payload.paymentDate.getTime() - payload.period.endDate.getTime()) / 86_400_000,
      );
      if (days > 7) {
        findings.push({
          code: 'PAYMENT_DATE_LATE',
          severity: 'WARNING',
          scope: 'RUN',
          field: 'paymentDate',
          message: `Payment date is ${days} days after the period end. Oman requires wages to be paid promptly — confirm this is within the permitted window.`,
        });
      }
    }

    // ── Per employee ────────────────────────────────────────────────────────
    const rule = IBAN_COUNTRY_RULES.OM;
    for (const row of payload.rows) {
      const base = {
        employeeId: row.employeeId,
        employeeCode: row.employeeCode,
        employeeName: row.fullName,
      };

      // Bank code is what routes the payment. A bank with no CBO code on file
      // cannot be routed, however valid the IBAN's checksum is.
      if (!row.bank.bankCode) {
        findings.push({
          ...base,
          code: 'BANK_CODE_UNKNOWN',
          severity: 'BLOCKING',
          scope: 'EMPLOYEE',
          field: 'bankCode',
          message: `${row.bank.bankName} has no CBO bank code on file, so the payment cannot be routed. Finance must set it under Bank Master.`,
        });
      }

      const iban = row.bank.iban;
      if (!iban) {
        findings.push({
          ...base,
          code: 'IBAN_MISSING',
          severity: 'BLOCKING',
          scope: 'EMPLOYEE',
          field: 'iban',
          message: 'Omani WPS requires an IBAN; this employee has none.',
        });
      } else {
        const res = validateIban(iban, 'OM', row.bank.bankCode);
        if (!res.valid) {
          findings.push({
            ...base,
            code: 'IBAN_INVALID',
            severity: 'BLOCKING',
            scope: 'EMPLOYEE',
            field: 'iban',
            message: res.message ?? 'IBAN is invalid.',
          });
        }
      }

      // Amounts must fit the file's fixed field width.
      if (row.net.minor.toString().length > OmanCboFormat.AMOUNT_WIDTH) {
        findings.push({
          ...base,
          code: 'AMOUNT_TOO_LARGE',
          severity: 'BLOCKING',
          scope: 'EMPLOYEE',
          field: 'netSalary',
          message: `Net pay ${minorToFixed(row.net)} exceeds the file's amount field width.`,
        });
      }

      // The name column is what a bank clerk eyeballs against the account holder.
      if (!row.bank.accountHolderName) {
        findings.push({
          ...base,
          code: 'ACCOUNT_HOLDER_MISSING',
          severity: 'WARNING',
          scope: 'EMPLOYEE',
          field: 'accountHolderName',
          message: 'No account holder name on file; the employee name will be sent instead.',
        });
      }

      if (iban && rule && iban.length === rule.length) {
        const embedded = iban.slice(rule.bankCodeRange![0], rule.bankCodeRange![1]);
        if (
          emp.employerBankCode &&
          embedded === emp.employerBankCode &&
          row.bank.bankCode === emp.employerBankCode
        ) {
          // Same-bank transfers are normal and cheaper; purely informational, so
          // no finding. Left as a comment to explain why nothing is raised.
        }
      }
    }

    return findings;
  }

  async generate(payload: WpsRunPayload): Promise<WpsArtifact[]> {
    const { EOL, AMOUNT_WIDTH } = OmanCboFormat;
    const emp = payload.employer.data ?? {};
    const purpose = optRun(payload, 'purposeCode', 'SAL');

    const lines: string[] = [];

    // ── Header (record type 01) ─────────────────────────────────────────────
    lines.push(
      [
        '01',
        emp.molEstablishmentNumber ?? '',
        emp.crNumber ?? '',
        csv(payload.employer.legalName),
        emp.employerBankCode ?? '',
        emp.employerAccountIban ?? '',
        `${payload.period.year}${pad2(payload.period.month)}`, // salary month YYYYMM
        compactDate(payload.paymentDate), // YYYYMMDD
        payload.currency,
        purpose,
        String(payload.rows.length),
        minorToPadded(payload.total, AMOUNT_WIDTH),
      ].join(','),
    );

    // ── Detail (record type 02), one per employee ───────────────────────────
    payload.rows.forEach((row, i) => {
      lines.push(
        [
          '02',
          String(i + 1), // sequence, 1-based
          csv(row.employeeCode),
          csv(row.identifiers.LABOUR_CARD?.number ?? ''),
          csv(row.identifiers.CIVIL_ID?.number ?? ''),
          csv(row.bank.accountHolderName || row.fullName),
          row.bank.bankCode ?? '',
          row.bank.iban ?? '',
          minorToPadded(row.basic, AMOUNT_WIDTH),
          minorToPadded(row.allowances, AMOUNT_WIDTH),
          minorToPadded(row.deductions, AMOUNT_WIDTH),
          minorToPadded(row.net, AMOUNT_WIDTH),
          String(row.workDays),
          String(row.lopDays),
        ].join(','),
      );
    });

    // ── Trailer (record type 09) ────────────────────────────────────────────
    // The record count and total are what a bank validator recomputes from the
    // detail rows. `total` is the sum of those same rows by construction (see
    // WpsRunPayload.total), so this balances or the payload itself is wrong.
    lines.push(
      [
        '09',
        String(payload.rows.length),
        minorToPadded(payload.total, AMOUNT_WIDTH),
        this.checksum(payload),
      ].join(','),
    );

    const text = lines.join(EOL) + EOL;

    // Deliberately latin1, not utf8: a fixed-record bank file must be one byte per
    // character or every downstream offset shifts. Names are ASCII-folded above.
    return [
      {
        fileName: this.fileName(payload),
        bytes: Buffer.from(text, 'latin1'),
        mimeType: 'text/plain',
        role: 'PRIMARY',
      },
    ];
  }

  /**
   * Self-consistency digit sum over the detail amounts.
   *
   * NOT a bank-specified algorithm — the real spec will define one. Until then
   * this at least detects a file truncated or edited after generation, and the
   * SHA-256 stored on WpsFile is the authoritative tamper check.
   */
  private checksum(payload: WpsRunPayload): string {
    const sum = payload.rows.reduce((acc, r) => acc + r.net.minor, 0n);
    return (sum % 9_999_999_937n).toString().padStart(10, '0');
  }

  /**
   * Bank-mandated naming is part of the spec we do not have. This is descriptive
   * and collision-free: establishment, period, and the run version so a corrected
   * v2 never overwrites v1 on the operator's disk.
   */
  private fileName(payload: WpsRunPayload): string {
    const est = (payload.employer.data?.molEstablishmentNumber ?? 'EMP').replace(
      /[^A-Za-z0-9]/g,
      '',
    );
    const period = `${payload.period.year}${pad2(payload.period.month)}`;
    return `WPS_OM_${est}_${period}_v${payload.version}.txt`;
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function compactDate(d: Date): string {
  return iso(d).replace(/-/g, '');
}

/**
 * Make a value safe for a comma-delimited record: strip separators and newlines,
 * and fold non-ASCII (Arabic names, diacritics) so the byte length matches the
 * character length. A stray comma would shift every subsequent column.
 */
function csv(value: string): string {
  return (value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining accents (Zoë -> Zoe)
    .replace(/[^\x20-\x7E]/g, '') // drop anything non-printable-ASCII
    .replace(/[,"\r\n]/g, ' ') // separators would shift every later column
    .replace(/\s+/g, ' ') // collapse the gaps that leaves
    .trim();
}

import { Injectable } from '@nestjs/common';
import { DynamicConfigField } from '../../common/config-schema/dynamic-config-field';
import { validateIban } from '../../bank-details/iban.util';
import {
  WpsArtifact,
  WpsFormat,
  WpsIdentifierRequirement,
} from '../types/wps-format.interface';
import { WpsFinding } from '../types/wps-finding';
import { WpsRunPayload, optRun } from '../types/wps-payload';
import { minorToFixed } from '../wps-money.util';

/**
 * Oman WPS — EDR/SCR record-tag variant, with decimal amounts.
 *
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │ ⚠ ALSO PROVISIONAL. Pick between this and `om-cbo-v1` on your bank's word.   │
 * │                                                                             │
 * │ Two candidate Oman layouts are shipped because the authoritative spec comes  │
 * │ from the sponsoring bank and we do not have it:                              │
 * │                                                                             │
 * │   om-cbo-v1      numeric record tags (01 header / 02 detail / 09 trailer),   │
 * │                  amounts as zero-padded integer baisa.                       │
 * │   om-sif-edr-v1  THIS ONE. Alphabetic record tags (EDR per employee, one SCR │
 * │                  control record last), amounts as decimals with exactly 3    │
 * │                  places (288.000).                                           │
 * │                                                                             │
 * │ Note honestly: the EDR/SCR convention is documented for the UAE's WPS SIF.   │
 * │ Whether Oman's sponsoring banks use the same convention is exactly what must │
 * │ be confirmed — this adapter exists so that if they do, it is a dropdown      │
 * │ change rather than a code change. Do not read its existence as evidence that  │
 * │ it is the correct Omani layout.                                             │
 * │                                                                             │
 * │ Either way the file must be accepted by the bank's TEST PORTAL before it is  │
 * │ used for a real payroll.                                                     │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *
 * Record layout implemented here:
 *
 *   EDR,<civilId>,<bankBIC>,<employeeIBAN>,<name>,<basic>,<allowances>,
 *       <deductions>,<frequency>,<MMYYYY>,<paymentType>,<remarks>
 *   SCR,<employerMolId>,<payerAccount>,<YYYYMMDD>,<HHMM>,<MMYYYY>,
 *       <totalEmployees>,<totalNetValue>,<currency>,<description>
 *
 * The SCR total is the sum of the EDR NET values (basic + allowances − deductions),
 * computed from the rows themselves — the arithmetic a bank validator recomputes.
 */
@Injectable()
export class OmanSifEdrFormat implements WpsFormat {
  readonly key = 'om-sif-edr-v1';
  readonly displayName = 'Oman WPS — SIF with EDR/SCR tags, decimal amounts (provisional)';
  readonly description =
    'Alternative Omani layout: one EDR line per employee plus a final SCR control ' +
    'record, amounts written as decimals to 3 places (288.000). Choose between this ' +
    'and the numeric-tag variant based on the specification your sponsoring bank ' +
    'supplies — both are provisional until confirmed against their test portal.';

  readonly country = 'OM';
  readonly currency = 'OMR';
  readonly currencyExponent = 3;
  readonly specVersion = 'OM-SIF-EDR/PROVISIONAL-2026-08';

  private static readonly EOL = '\r\n';

  readonly employerConfigSchema: DynamicConfigField[] = [
    {
      name: 'molEstablishmentNumber',
      label: 'Ministry of Labour establishment number',
      type: 'text',
      required: true,
      help: 'Written to the SCR control record as the employer identifier.',
      placeholder: 'e.g. 1234567',
    },
    {
      name: 'employerAccountIban',
      label: 'Employer salary account IBAN (payer account)',
      type: 'text',
      required: true,
      help: 'The Omani account salaries are debited from. 23 characters.',
      placeholder: 'OM…',
    },
    {
      name: 'employerBankCode',
      label: 'Employer bank code (CBO, 3 digits)',
      type: 'text',
      required: true,
      help: 'Must match the bank code embedded in the payer IBAN above.',
      placeholder: 'e.g. 018',
    },
    {
      name: 'crNumber',
      label: 'Commercial registration (CR) number',
      type: 'text',
      required: false,
      help: 'Not carried in this layout; kept so the profile survives switching format.',
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
      name: 'frequency',
      label: 'Pay frequency',
      type: 'select',
      required: false,
      default: 'M',
      options: [
        { value: 'M', label: 'M — monthly' },
        { value: 'W', label: 'W — weekly' },
        { value: 'B', label: 'B — bi-weekly' },
      ],
      help: 'Written to the frequency column of every EDR line.',
    },
    {
      name: 'paymentType',
      label: 'Payment type code',
      type: 'select',
      required: false,
      default: '1',
      options: [
        { value: '1', label: '1 — regular salary' },
        { value: '2', label: '2 — arrears / back pay' },
        { value: '3', label: '3 — final settlement' },
      ],
    },
    {
      name: 'description',
      label: 'File description',
      type: 'text',
      required: false,
      help: 'Free text on the SCR line. Defaults to "Salary <MM/YYYY>".',
    },
  ];

  /**
   * The civil ID is the employee identifier column in this layout, so a blank one
   * makes the row unusable rather than merely incomplete — hence BLOCKING, unlike
   * in `om-cbo-v1` where the identifier columns are supplementary.
   *
   * A consequence worth knowing before choosing this format: every employee needs a
   * CIVIL_ID recorded under their legal documents, or the pre-flight refuses.
   */
  readonly requiredIdentifiers: WpsIdentifierRequirement[] = [
    {
      category: 'CIVIL_ID',
      label: 'Civil ID',
      severity: 'BLOCKING',
    },
    {
      category: 'LABOUR_CARD',
      label: 'Labour card',
      severity: 'WARNING',
      mustBeUnexpired: true,
    },
  ];

  validate(payload: WpsRunPayload): WpsFinding[] {
    const findings: WpsFinding[] = [];
    const emp = payload.employer.data ?? {};

    const payer = (emp.employerAccountIban || '').trim();
    const employerBankCode = (emp.employerBankCode || '').trim();

    if (payer) {
      const res = validateIban(payer, 'OM', employerBankCode || null);
      if (!res.valid) {
        findings.push({
          code: 'EMPLOYER_ACCOUNT_INVALID',
          severity: 'BLOCKING',
          scope: 'EMPLOYER',
          field: 'employerAccountIban',
          message: `Payer account is not a valid Omani IBAN: ${res.message}`,
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

    if (payload.paymentDate < payload.period.endDate) {
      findings.push({
        code: 'PAYMENT_DATE_BEFORE_PERIOD_END',
        severity: 'BLOCKING',
        scope: 'RUN',
        field: 'paymentDate',
        message: `Payment date ${iso(payload.paymentDate)} is before the period ends (${iso(payload.period.endDate)}).`,
      });
    }

    for (const row of payload.rows) {
      const base = {
        employeeId: row.employeeId,
        employeeCode: row.employeeCode,
        employeeName: row.fullName,
      };

      if (!row.bank.iban) {
        findings.push({
          ...base,
          code: 'IBAN_MISSING',
          severity: 'BLOCKING',
          scope: 'EMPLOYEE',
          field: 'iban',
          message: 'Omani WPS requires an IBAN; this employee has none.',
        });
      } else {
        const res = validateIban(row.bank.iban, 'OM', row.bank.bankCode);
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

      // The BIC column is what routes an EDR line.
      if (!row.bank.swift && !row.bank.bankCode) {
        findings.push({
          ...base,
          code: 'BANK_CODE_UNKNOWN',
          severity: 'BLOCKING',
          scope: 'EMPLOYEE',
          field: 'bankCode',
          message: `${row.bank.bankName} has neither a SWIFT/BIC nor a CBO code on file, so the EDR line cannot be routed. Finance must set one under Bank Master.`,
        });
      }
    }

    return findings;
  }

  async generate(payload: WpsRunPayload): Promise<WpsArtifact[]> {
    const { EOL } = OmanSifEdrFormat;
    const emp = payload.employer.data ?? {};
    const frequency = optRun(payload, 'frequency', 'M');
    const paymentType = optRun(payload, 'paymentType', '1');
    const mmyyyy = `${pad2(payload.period.month)}${payload.period.year}`;
    const description =
      optRun(payload, 'description', '') ||
      `Salary ${pad2(payload.period.month)}/${payload.period.year}`;

    const lines: string[] = [];

    // ── EDR: one per employee ───────────────────────────────────────────────
    for (const row of payload.rows) {
      lines.push(
        [
          'EDR',
          csv(row.identifiers.CIVIL_ID?.number ?? ''),
          csv(row.bank.swift ?? row.bank.bankCode ?? ''),
          row.bank.iban ?? '',
          csv(row.bank.accountHolderName || row.fullName),
          // Decimals to exactly 3 places, from integer baisa — no float anywhere.
          minorToFixed(row.basic),
          minorToFixed(row.allowances),
          minorToFixed(row.deductions),
          frequency,
          mmyyyy,
          paymentType,
          csv(description),
        ].join(','),
      );
    }

    // ── SCR: one control record, last ───────────────────────────────────────
    lines.push(
      [
        'SCR',
        emp.molEstablishmentNumber ?? '',
        emp.employerAccountIban ?? '',
        compactDate(payload.paymentDate),
        compactTime(payload.generatedAt),
        mmyyyy,
        String(payload.rows.length),
        minorToFixed(payload.total),
        payload.currency,
        csv(description),
      ].join(','),
    );

    const text = lines.join(EOL) + EOL;

    // latin1, not utf8: a fixed-record bank file must be one byte per character or
    // every downstream offset shifts. Names are ASCII-folded in csv() above.
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
   * `<establishment><YYMMDD><HHMM>.SIF` — the naming convention this record style
   * is usually paired with. Provisional like everything else here; the version
   * suffix keeps a corrected v2 from overwriting v1 on the operator's disk.
   */
  private fileName(payload: WpsRunPayload): string {
    const est = (payload.employer.data?.molEstablishmentNumber ?? 'EMP').replace(
      /[^A-Za-z0-9]/g,
      '',
    );
    const d = iso(payload.paymentDate).slice(2).replace(/-/g, '');
    return `${est}${d}${compactTime(payload.generatedAt)}_v${payload.version}.SIF`;
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

function compactTime(d: Date): string {
  return d.toISOString().slice(11, 16).replace(':', '');
}

/** Strip separators and fold to ASCII so a name cannot shift later columns. */
function csv(value: string): string {
  return (value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[,"\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

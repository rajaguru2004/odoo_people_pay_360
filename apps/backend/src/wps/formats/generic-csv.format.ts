import { Injectable } from '@nestjs/common';
import { DynamicConfigField } from '../../common/config-schema/dynamic-config-field';
import {
  WpsArtifact,
  WpsFormat,
  WpsIdentifierRequirement,
} from '../types/wps-format.interface';
import { WpsFinding } from '../types/wps-finding';
import { WpsRunPayload } from '../types/wps-payload';
import { minorToFixed } from '../wps-money.util';

/**
 * A plain, human-readable CSV payment instruction — country-neutral.
 *
 * NOT a legal submission format anywhere. It exists so that:
 *   • the whole flow (pre-flight → generate → download → submit → bank response →
 *     corrected v2) is exercisable in a market whose real layout we have not
 *     implemented yet, and
 *   • the framework has a second registered format from day one, which is what
 *     proves the abstraction is real rather than an Oman exporter with extra
 *     indirection.
 *
 * `country: '*'` makes it offered for every branch. Currency and exponent come
 * from the branch's configured payroll currency at build time rather than being
 * fixed here, which is why they are mutable on this class.
 */
@Injectable()
export class GenericCsvFormat implements WpsFormat {
  readonly key = 'generic-csv-v1';
  readonly displayName = 'Generic CSV payment instruction';
  readonly description =
    'Country-neutral CSV listing each employee, their account and net pay. Useful for ' +
    'testing the flow end to end, or for a bank that accepts a plain payment list. ' +
    'Not a government WPS submission format.';

  readonly country = '*';
  readonly currency = 'OMR';
  readonly currencyExponent = 3;
  readonly specVersion = 'GENERIC-CSV/1';

  readonly employerConfigSchema: DynamicConfigField[] = [
    {
      name: 'employerReference',
      label: 'Employer reference',
      type: 'text',
      required: true,
      help: 'Whatever your bank uses to identify the debiting company. Free text.',
    },
    {
      name: 'employerAccount',
      label: 'Employer account / IBAN',
      type: 'text',
      required: true,
      help: 'The account salaries are debited from.',
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
      name: 'includeBreakdown',
      label: 'Include basic / allowances / deductions columns',
      type: 'boolean',
      required: false,
      default: true,
      help: 'Off produces just the net payment instruction.',
    },
  ];

  /** Deliberately none: a plain payment list needs only an account. */
  readonly requiredIdentifiers: WpsIdentifierRequirement[] = [];

  validate(payload: WpsRunPayload): WpsFinding[] {
    const findings: WpsFinding[] = [];
    for (const row of payload.rows) {
      // The core already blocks a missing account outright; this catches the case
      // where a country's field schema has neither an IBAN nor an account number,
      // which would produce a payment line with nowhere to send the money.
      if (!row.bank.iban && !row.bank.accountNumber) {
        findings.push({
          code: 'NO_ACCOUNT_IDENTIFIER',
          severity: 'BLOCKING',
          scope: 'EMPLOYEE',
          employeeId: row.employeeId,
          employeeCode: row.employeeCode,
          employeeName: row.fullName,
          field: 'iban',
          message:
            'Bank details hold neither an IBAN nor an account number, so there is no destination to pay.',
        });
      }
    }
    return findings;
  }

  async generate(payload: WpsRunPayload): Promise<WpsArtifact[]> {
    const includeBreakdown =
      payload.runOptions?.includeBreakdown === undefined
        ? true
        : payload.runOptions.includeBreakdown === true ||
          payload.runOptions.includeBreakdown === 'true';

    const header = [
      'sequence',
      'employee_code',
      'employee_name',
      'bank_name',
      'bank_code',
      'account',
      ...(includeBreakdown ? ['basic', 'allowances', 'deductions'] : []),
      'net',
      'currency',
    ];

    const rows = payload.rows.map((row, i) =>
      [
        String(i + 1),
        q(row.employeeCode),
        q(row.bank.accountHolderName || row.fullName),
        q(row.bank.bankName),
        q(row.bank.bankCode ?? ''),
        q(row.bank.iban ?? row.bank.accountNumber ?? ''),
        ...(includeBreakdown
          ? [minorToFixed(row.basic), minorToFixed(row.allowances), minorToFixed(row.deductions)]
          : []),
        minorToFixed(row.net),
        row.net.currency,
      ].join(','),
    );

    // Trailer so the file is self-checking the same way a real SIF is: the count
    // and total a validator would recompute from the detail lines above.
    const trailer = [
      'TOTAL',
      String(payload.rows.length),
      '',
      '',
      '',
      '',
      ...(includeBreakdown ? ['', '', ''] : []),
      minorToFixed(payload.total),
      payload.total.currency,
    ].join(',');

    const text = [header.join(','), ...rows, trailer].join('\r\n') + '\r\n';

    const period = `${payload.period.year}${String(payload.period.month).padStart(2, '0')}`;
    return [
      {
        fileName: `payment_instruction_${payload.branch.code}_${period}_v${payload.version}.csv`,
        bytes: Buffer.from(text, 'utf8'),
        mimeType: 'text/csv',
        role: 'PRIMARY',
      },
    ];
  }
}

/** Minimal CSV quoting — quote only when needed, escape embedded quotes. */
function q(value: string): string {
  const v = value ?? '';
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

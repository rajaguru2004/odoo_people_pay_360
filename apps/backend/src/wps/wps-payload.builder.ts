import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { assertInBranch } from '../common/branch/branch-scope.util';
import {
  branchAllowedCountries,
  validateBankingData,
} from '../bank-details/banking-fields.util';
import { BankingConfigService } from '../bank-details/banking-config.service';
import { WpsFormatRegistry } from './formats/wps-format.registry';
import { WpsFormat } from './types/wps-format.interface';
import { WpsFinding } from './types/wps-finding';
import { WpsEmployeeRow, WpsRunPayload } from './types/wps-payload';
import { decryptSecret } from '../common/crypto/secret-crypto';
import {
  WpsMoney,
  WpsPrecisionError,
  addMinor,
  sumMinor,
  toMinor,
  zeroMoney,
} from './wps-money.util';

/** Payroll statuses that mean "these figures can still change". */
const NON_FINAL_PAYROLL = ['DRAFT', 'PENDING_APPROVAL', 'REJECTED'] as const;

export interface WpsBuildResult {
  format: WpsFormat;
  branch: { id: string; code: string; name: string; country: string };
  payroll: {
    id: string;
    month: number;
    year: number;
    version: number;
    status: string;
    branchId: string | null;
  };
  configurationId: string | null;
  employerSnapshot: Record<string, string>;
  employerLegalName: string;

  /** Run/employer-level problems. */
  runFindings: WpsFinding[];
  /** Per-employee problems, keyed by employee id. */
  employeeFindings: Map<string, WpsFinding[]>;
  /** Everyone considered for this run, in file order. */
  employees: { id: string; code: string; fullName: string }[];
  /** Rows that could be fully assembled. Fewer than `employees` when some blocked. */
  rows: WpsEmployeeRow[];
  total: WpsMoney;
  currency: string;
  currencyExponent: number;
  paymentDate: Date;
  period: { month: number; year: number; startDate: Date; endDate: Date };
}

/**
 * Turns a locked payroll into the normalized, format-agnostic payload — and
 * collects every core (format-independent) reason a file must not be produced.
 *
 * Everything money-shaped goes through `toMinor`, which throws rather than rounds:
 * the file's header total must equal the sum of its own detail rows, because that
 * is the arithmetic a bank validator recomputes.
 */
@Injectable()
export class WpsPayloadBuilder {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: WpsFormatRegistry,
    private readonly bankingConfig: BankingConfigService,
  ) {}

  async build(payrollId: string): Promise<WpsBuildResult> {
    const payroll = await this.prisma.payroll.findUnique({
      where: { id: payrollId },
      include: { branch: true },
    });
    if (!payroll) throw new NotFoundException('Payroll not found');

    // findUnique bypasses the auto-scoping middleware.
    assertInBranch(payroll.branchId);

    const runFindings: WpsFinding[] = [];
    const employeeFindings = new Map<string, WpsFinding[]>();
    const addEmp = (employeeId: string, f: WpsFinding) => {
      const list = employeeFindings.get(employeeId) ?? [];
      list.push(f);
      employeeFindings.set(employeeId, list);
    };

    // ── Run-level gates that make the rest meaningless ──────────────────────
    if (!payroll.branchId || !payroll.branch) {
      // A company-wide run can span countries and currencies, so it cannot map to
      // one employer's file. Refusing is the only correct answer.
      throw new BadRequestException(
        'This payroll is not attached to a branch (a legacy company-wide run), so no wage file can be produced for it. Generate per-branch payroll instead.',
      );
    }

    const branch = {
      id: payroll.branch.id,
      code: payroll.branch.code,
      name: payroll.branch.name,
      country: (payroll.branch.country ?? '').toUpperCase(),
    };

    const config = await this.prisma.wpsConfiguration.findUnique({
      where: { branchId: payroll.branchId },
      include: { employerProfile: true },
    });

    if (!config) {
      throw new BadRequestException(
        `No wage-file configuration exists for branch ${branch.code}. Set it up under Settings → Salary Payment Files.`,
      );
    }

    const format = this.registry.get(config.format);
    const currency = format.currency;
    const exponent = format.currencyExponent;

    if (!config.enabled) {
      runFindings.push({
        code: 'WPS_DISABLED',
        severity: 'BLOCKING',
        scope: 'RUN',
        message: `Wage-file generation is switched off for branch ${branch.code}.`,
      });
    }

    // ── The lock gate ───────────────────────────────────────────────────────
    // `status === 'LOCKED'` alone is not enough. `lockedAt` is written only by the
    // real lock path and `approvedAt` only by the approval path, so requiring both
    // rejects a run that reached LOCKED through the old finalize shortcut without
    // settling reimbursements and loan installments.
    const properlyLocked =
      payroll.status === 'LOCKED' &&
      payroll.lockedAt != null &&
      payroll.approvedAt != null;

    if (!properlyLocked) {
      // Two different failures with two DIFFERENT remedies, so they get different
      // codes. Telling someone to "submit for approval" when the run is already
      // LOCKED is advice they cannot act on — submit, approve and lock all reject a
      // LOCKED payroll, leaving them stuck with no next step.
      if (payroll.status !== 'LOCKED') {
        runFindings.push({
          code: 'PAYROLL_NOT_PROPERLY_LOCKED',
          severity: 'BLOCKING',
          scope: 'RUN',
          message: `Payroll is ${payroll.status}, not LOCKED. A wage file must come from finalised figures that can no longer change — submit it for approval, approve it, then lock it.`,
        });
      } else {
        // Legacy state: an older code path moved runs straight to LOCKED without
        // approval, and without settling reimbursements or advance/loan
        // installments. The only way forward is a revision, which starts a fresh
        // DRAFT at version+1 that can go through the real lifecycle.
        const missing = [
          payroll.approvedAt == null ? 'never approved' : null,
          payroll.lockedAt == null ? 'no lock timestamp' : null,
        ]
          .filter(Boolean)
          .join(', ');
        runFindings.push({
          code: 'PAYROLL_LOCKED_WITHOUT_APPROVAL',
          severity: 'BLOCKING',
          scope: 'RUN',
          message: `This payroll reads as LOCKED but was finalised by an older code path that skipped approval (${missing}), so its reimbursements and advance/loan installments were never settled. It cannot be re-locked. Create a revision from it, then take the revision through submit → approve → lock.`,
        });
      }
    }

    // ── Employer profile ────────────────────────────────────────────────────
    const profile = config.employerProfile;
    const rawEmployer = (profile.data as Record<string, string>) ?? {};
    const employerSnapshot: Record<string, string> = {};

    for (const field of format.employerConfigSchema) {
      const raw = rawEmployer[field.name];
      let value = typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
      if (field.secret && value) {
        try {
          value = decryptSecret(value) ?? '';
        } catch {
          runFindings.push({
            code: 'EMPLOYER_FIELD_INVALID',
            severity: 'BLOCKING',
            scope: 'EMPLOYER',
            field: field.name,
            message: `${field.label} could not be decrypted. Re-enter it.`,
          });
          value = '';
        }
      }
      if (field.required && !value.trim()) {
        runFindings.push({
          code: 'EMPLOYER_FIELD_MISSING',
          severity: 'BLOCKING',
          scope: 'EMPLOYER',
          field: field.name,
          message: `${field.label} is required for ${format.displayName} but is not set.`,
        });
      }
      employerSnapshot[field.name] = value;
    }

    // ── Period + payment date ───────────────────────────────────────────────
    const period = {
      month: payroll.month,
      year: payroll.year,
      startDate: new Date(Date.UTC(payroll.year, payroll.month - 1, 1)),
      endDate: new Date(Date.UTC(payroll.year, payroll.month, 0)),
    };

    const runOptions = (config.defaultRunOptions as Record<string, unknown>) ?? {};
    const paymentDate = parsePaymentDate(runOptions.paymentDate, period.endDate);

    // ── Employees on the run ────────────────────────────────────────────────
    const items = await this.prisma.payrollItem.findMany({
      where: { payrollId },
      include: {
        employee: {
          include: { profile: { select: { nationality: true } } },
        },
      },
      orderBy: { employee: { employeeCode: 'asc' } },
    });

    const employees = items.map((i) => ({
      id: i.employeeId,
      code: i.employee.employeeCode,
      fullName: i.employee.fullName,
    }));
    const employeeIds = employees.map((e) => e.id);

    // Bank details, identifiers, pending changes and pay history — batched.
    // `in: []` matches nothing, so the empty-run case needs no special casing.
    const [details, pendingChanges, identifierDocs, historyItems] = await Promise.all([
      this.prisma.employeeBankDetail.findMany({
        where: { employeeId: { in: employeeIds }, isActive: true },
        include: { bank: true },
      }),
      this.prisma.bankChangeRequest.findMany({
        where: { employeeId: { in: employeeIds }, status: 'PENDING' },
        select: { employeeId: true },
      }),
      format.requiredIdentifiers.length
        ? this.prisma.employeeLegalDocument.findMany({
            where: {
              employeeId: { in: employeeIds },
              isCurrent: true,
              category: {
                in: format.requiredIdentifiers.map((r) => r.category) as any[],
              },
            },
            select: {
              employeeId: true,
              category: true,
              documentNumber: true,
              expiryDate: true,
            },
          })
        : this.prisma.employeeLegalDocument.findMany({
            where: { id: '00000000-0000-0000-0000-000000000000' },
            select: {
              employeeId: true,
              category: true,
              documentNumber: true,
              expiryDate: true,
            },
          }),
      this.prisma.payrollItem.findMany({
        where: {
          employeeId: { in: employeeIds },
          payrollId: { not: payrollId },
          payroll: { status: 'LOCKED' },
        },
        select: { employeeId: true, netSalary: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const detailByEmp = new Map(details.map((d) => [d.employeeId, d] as const));
    const pendingSet = new Set(pendingChanges.map((p) => p.employeeId));
    const docsByEmp = new Map<string, typeof identifierDocs>();
    for (const doc of identifierDocs) {
      const list = docsByEmp.get(doc.employeeId) ?? [];
      list.push(doc);
      docsByEmp.set(doc.employeeId, list);
    }
    const historyByEmp = new Map<string, number[]>();
    for (const h of historyItems) {
      const list = historyByEmp.get(h.employeeId) ?? [];
      if (list.length < 3) list.push(Number(h.netSalary));
      historyByEmp.set(h.employeeId, list);
    }

    const allowedCountries = branchAllowedCountries(payroll.branch);
    const fieldCache = new Map<string, Awaited<ReturnType<BankingConfigService['getFieldsForCountry']>>>();
    const fieldsFor = async (country: string) => {
      const cc = (country || '').toUpperCase();
      if (!fieldCache.has(cc)) {
        fieldCache.set(cc, await this.bankingConfig.getFieldsForCountry(cc));
      }
      return fieldCache.get(cc)!;
    };

    // ── Leavers who never made it onto the run ──────────────────────────────
    // Approving a termination flips the employee to INACTIVE immediately, and
    // payroll only selects ACTIVE employees — so someone who left mid-period has
    // no item to warn about and their final wages would silently never be paid.
    // This has to be its own query, independent of the items above.
    const missingLeavers = await this.prisma.employee.findMany({
      where: {
        branchId: payroll.branchId,
        endDate: { gte: period.startDate, lte: period.endDate },
        id: { notIn: employeeIds.length ? employeeIds : ['00000000-0000-0000-0000-000000000000'] },
      },
      select: { id: true, employeeCode: true, fullName: true, endDate: true },
    });
    for (const leaver of missingLeavers) {
      runFindings.push({
        code: 'EMPLOYEE_MISSING_FROM_RUN',
        severity: 'BLOCKING',
        scope: 'RUN',
        employeeId: leaver.id,
        employeeCode: leaver.employeeCode,
        employeeName: leaver.fullName,
        message: `${leaver.fullName} (${leaver.employeeCode}) left on ${iso(leaver.endDate!)}, inside this period, but has no line in this payroll. Their final wages would not be paid. Revise the payroll to include them.`,
      });
    }

    // ── Per-employee assembly ───────────────────────────────────────────────
    const rows: WpsEmployeeRow[] = [];

    for (const item of items) {
      const emp = item.employee;
      const base = {
        employeeId: emp.id,
        employeeCode: emp.employeeCode,
        employeeName: emp.fullName,
      };
      let blocked = false;

      if (emp.branchId !== payroll.branchId) {
        addEmp(emp.id, {
          ...base,
          code: 'NOT_IN_BRANCH',
          severity: 'BLOCKING',
          scope: 'EMPLOYEE',
          message: `${emp.fullName} is not in branch ${branch.code} but appears on its payroll.`,
        });
        blocked = true;
      }

      if (pendingSet.has(emp.id)) {
        addEmp(emp.id, {
          ...base,
          code: 'BANK_CHANGE_PENDING',
          severity: 'BLOCKING',
          scope: 'EMPLOYEE',
          message:
            'A bank-detail change is awaiting approval. Decide it before generating, or the file may pay the wrong account.',
        });
        blocked = true;
      }

      const detail = detailByEmp.get(emp.id);
      if (!detail) {
        addEmp(emp.id, {
          ...base,
          code: 'NO_ACTIVE_BANK_DETAIL',
          severity: 'BLOCKING',
          scope: 'EMPLOYEE',
          field: 'iban',
          message: 'No bank details on file, so there is nowhere to send the salary.',
        });
        blocked = true;
      }

      // Net pay must be payable.
      const net = Number(item.netSalary);
      if (net <= 0) {
        addEmp(emp.id, {
          ...base,
          code: 'NET_NOT_POSITIVE',
          severity: 'BLOCKING',
          scope: 'EMPLOYEE',
          field: 'netSalary',
          message: `Net pay is ${net}. A wage file cannot carry a zero or negative payment — correct the payroll or exclude the employee.`,
        });
        blocked = true;
      }

      // Bank/account validity, re-checked against the country's live field schema
      // rather than trusted from when it was saved.
      if (detail) {
        const bankCountry = (detail.bank?.country ?? '').toUpperCase();
        if (!detail.bank?.isActive) {
          addEmp(emp.id, {
            ...base,
            code: 'BANK_INACTIVE',
            severity: 'BLOCKING',
            scope: 'EMPLOYEE',
            message: `${detail.bank?.name ?? 'The selected bank'} is marked inactive.`,
          });
          blocked = true;
        }
        if (allowedCountries.length && !allowedCountries.includes(bankCountry)) {
          addEmp(emp.id, {
            ...base,
            code: 'BANK_COUNTRY_NOT_ALLOWED',
            severity: 'BLOCKING',
            scope: 'EMPLOYEE',
            message: `Account is with a ${bankCountry} bank, which is not among this branch's allowed banking countries (${allowedCountries.join(', ')}).`,
          });
          blocked = true;
        }

        const fields = await fieldsFor(bankCountry);
        const data = (detail.data as Record<string, unknown>) ?? {};
        const res = validateBankingData(bankCountry, data, fields, detail.bank?.bankCode);
        if (!res.valid) {
          for (const [field, message] of Object.entries(res.errors)) {
            addEmp(emp.id, {
              ...base,
              code: 'BANK_DETAIL_INVALID',
              severity: 'BLOCKING',
              scope: 'EMPLOYEE',
              field,
              message,
            });
          }
          blocked = true;
        }
      }

      // Identifiers the format asked for.
      const docs = docsByEmp.get(emp.id) ?? [];
      const identifiers: WpsEmployeeRow['identifiers'] = {};
      for (const req of format.requiredIdentifiers) {
        const doc = docs.find((d) => String(d.category) === req.category);
        if (!doc) {
          addEmp(emp.id, {
            ...base,
            code: 'IDENTIFIER_MISSING',
            severity: req.severity,
            scope: 'EMPLOYEE',
            field: req.category,
            message: `No ${req.label} on file. Add it under the employee's legal documents.`,
          });
          if (req.severity === 'BLOCKING') blocked = true;
          continue;
        }
        identifiers[req.category] = {
          number: doc.documentNumber,
          expiryDate: doc.expiryDate ?? null,
        };
        if (req.mustBeUnexpired && doc.expiryDate && doc.expiryDate < paymentDate) {
          addEmp(emp.id, {
            ...base,
            code: 'IDENTIFIER_EXPIRED',
            severity: req.severity,
            scope: 'EMPLOYEE',
            field: req.category,
            message: `${req.label} expired on ${iso(doc.expiryDate)}, before the payment date.`,
          });
          if (req.severity === 'BLOCKING') blocked = true;
        }
        if (req.pattern && !new RegExp(req.pattern).test(doc.documentNumber)) {
          addEmp(emp.id, {
            ...base,
            code: 'IDENTIFIER_FORMAT',
            severity: req.severity,
            scope: 'EMPLOYEE',
            field: req.category,
            message: `${req.label} '${doc.documentNumber}' does not match the format this scheme expects.`,
          });
          if (req.severity === 'BLOCKING') blocked = true;
        }
      }

      // ── Warnings that do not block ──────────────────────────────────────
      if (detail?.accountHolderName && emp.fullName) {
        if (normalizeName(detail.accountHolderName) !== normalizeName(emp.fullName)) {
          addEmp(emp.id, {
            ...base,
            code: 'BENEFICIARY_NAME_MISMATCH',
            severity: 'WARNING',
            scope: 'EMPLOYEE',
            field: 'accountHolderName',
            message: `Account holder '${detail.accountHolderName}' does not match the employee name '${emp.fullName}'. Banks may reject a mismatched beneficiary.`,
          });
        }
      }

      if (emp.endDate && emp.endDate >= period.startDate && emp.endDate <= period.endDate) {
        addEmp(emp.id, {
          ...base,
          code: 'EMPLOYEE_LEFT_MID_PERIOD',
          severity: 'WARNING',
          scope: 'EMPLOYEE',
          message: `Left on ${iso(emp.endDate)}, inside this period. Confirm the amount is their correct final pay.`,
        });
      }

      const history = historyByEmp.get(emp.id) ?? [];
      if (history.length >= 3 && net > 0) {
        const mean = history.reduce((s, n) => s + n, 0) / history.length;
        if (mean > 0 && Math.abs(net - mean) / mean > 0.3) {
          addEmp(emp.id, {
            ...base,
            code: 'SALARY_DEVIATION',
            severity: 'WARNING',
            scope: 'EMPLOYEE',
            field: 'netSalary',
            message: `Net pay ${net.toFixed(2)} differs from the trailing 3-month average (${mean.toFixed(2)}) by more than 30%.`,
          });
        }
      }

      if (blocked || !detail) continue;

      // ── Money. Throws rather than rounds — see toMinor. ─────────────────
      try {
        const m = (v: unknown, field: string) => toMinor(v as any, currency, exponent, field);
        const basic = m(item.baseSalary, 'baseSalary');
        const allowances = addMinor(
          m(item.allowances, 'allowances'),
          m(item.foodAllowance, 'foodAllowance'),
          m(item.siteAllowance, 'siteAllowance'),
          m(item.bonus, 'bonus'),
          m(item.overtimePay, 'overtimePay'),
          m(item.reimbursement, 'reimbursement'),
        );
        const deductions = addMinor(
          m(item.deduction, 'deduction'),
          m(item.advanceLoanDeduction, 'advanceLoanDeduction'),
          m(item.insurance, 'insurance'),
          m(item.tax, 'tax'),
        );
        const netMoney = m(item.netSalary, 'netSalary');

        const bankData = (detail.data as Record<string, string>) ?? {};
        rows.push({
          employeeId: emp.id,
          payrollItemId: item.id,
          employeeCode: emp.employeeCode,
          fullName: emp.fullName,
          identifiers,
          startDate: emp.startDate,
          endDate: emp.endDate ?? null,
          salaryType: (emp.salaryType as 'MONTHLY' | 'DAILY') ?? 'MONTHLY',
          nationality: emp.profile?.nationality ?? null,
          bank: {
            bankId: detail.bankId,
            bankName: detail.bank?.name ?? '',
            bankCode: detail.bank?.bankCode ?? null,
            swift: detail.bank?.swift ?? null,
            country: (detail.bank?.country ?? '').toUpperCase(),
            fields: bankData,
            iban: bankData.iban ?? detail.iban ?? null,
            accountNumber: bankData.accountNumber ?? detail.accountNumber ?? null,
            accountHolderName:
              bankData.accountHolderName ?? detail.accountHolderName ?? null,
            bankDetailId: detail.id,
          },
          basic,
          allowances,
          deductions,
          net: netMoney,
          gross: addMinor(basic, allowances),
          workDays: item.workDays,
          actualWorkDays: Number(item.actualWorkDays),
          lopDays: Math.max(0, item.workDays - Number(item.actualWorkDays)),
          extra: {},
        });
      } catch (err) {
        if (err instanceof WpsPrecisionError) {
          addEmp(emp.id, {
            ...base,
            code: 'PRECISION_LOSS',
            severity: 'BLOCKING',
            scope: 'EMPLOYEE',
            field: err.field,
            message: err.message,
          });
          continue;
        }
        throw err;
      }
    }

    const total = rows.length
      ? sumMinor(rows.map((r) => r.net), currency, exponent)
      : zeroMoney(currency, exponent);

    return {
      format,
      branch,
      payroll: {
        id: payroll.id,
        month: payroll.month,
        year: payroll.year,
        version: payroll.version,
        status: payroll.status,
        branchId: payroll.branchId,
      },
      configurationId: config.id,
      employerSnapshot,
      employerLegalName: profile.legalName,
      runFindings,
      employeeFindings,
      employees,
      rows,
      total,
      currency,
      currencyExponent: exponent,
      paymentDate,
      period,
    };
  }

  /** Assemble the adapter-facing payload. Only valid when nothing is blocking. */
  toPayload(
    build: WpsBuildResult,
    args: {
      runId: string;
      version: number;
      runOptions: Record<string, unknown>;
      generatedBy: { userId: string; name: string };
      lockedAt: Date;
      approvedAt: Date;
    },
  ): WpsRunPayload {
    return {
      runId: args.runId,
      version: args.version,
      format: build.format.key,
      specVersion: build.format.specVersion,
      branch: build.branch,
      employer: {
        data: build.employerSnapshot,
        legalName: build.employerLegalName,
        country: build.branch.country,
      },
      period: build.period,
      paymentDate: parsePaymentDate(args.runOptions.paymentDate, build.paymentDate),
      payroll: {
        id: build.payroll.id,
        version: build.payroll.version,
        lockedAt: args.lockedAt,
        approvedAt: args.approvedAt,
      },
      rows: build.rows,
      total: build.total,
      currency: build.currency,
      currencyExponent: build.currencyExponent,
      runOptions: args.runOptions,
      generatedAt: new Date(),
      generatedBy: args.generatedBy,
    };
  }
}

export { NON_FINAL_PAYROLL };

function parsePaymentDate(raw: unknown, fallback: Date): Date {
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const d = new Date(`${raw}T00:00:00.000Z`);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return fallback;
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Compare beneficiary names ignoring case, punctuation and spacing. */
function normalizeName(v: string): string {
  return (v || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

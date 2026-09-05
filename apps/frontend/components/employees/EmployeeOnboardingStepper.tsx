'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from '@/lib/toast';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Check, User, Briefcase, FileText,
  ClipboardList, Plus, Trash2, Building2, MapPin,
  Calendar, Phone, Mail, BadgeCheck, CreditCard, Globe,
  Clock, Hash, Shield, TrendingDown, TrendingUp, X, Lock,
} from 'lucide-react';
import { CurrencyIcon } from '@/components/common/CurrencyIcon';
import { useTranslations } from 'next-intl';
import { ArrowLeftIcon, ArrowRightIcon, ChevronRightIcon } from '@/components/common/icons/directional';
import PageActionRow from '@/components/common/PageActionRow';
import { usePageHeader } from '@/hooks/usePageHeader';
import employeeService from '@/services/employeeService';
import { employeeProfileService } from '@/services/employeeProfileService';
import departmentService from '@/services/departmentService';
import branchService from '@/services/branchService';
import { Branch } from '@/types/branch';
import { useBranchStore } from '@/store/branchStore';
import libraryService, { LibraryItem } from '@/services/libraryService';
import overtimePolicyService from '@/services/overtimePolicyService';
import contractService from '@/services/contractService';
import salaryComponentService from '@/services/salaryComponentService';
import {
  SALARY_COMPONENT_OPTIONS,
  SalaryComponentTypeOption,
  componentLabel,
  optionsFromLibrary,
  toComponentCode,
} from '@/utils/salaryComponentUtils';
import systemSettingsService from '@/services/systemSettingsService';
import { Department } from '@/types/department';
import { departmentPickerOptions } from '@/lib/departmentOptions';
import { useConfirm } from '@/hooks/useConfirm';
import { useStartDateBounds } from '@/hooks/useStartDateBounds';
import TimezoneSelect from '@/components/common/TimezoneSelect';
import { useProfileTemplate } from '@/hooks/useProfileTemplate';
import { TemplateFormRenderer } from '@/components/dynamic-form/TemplateFormRenderer';
import {
  buildTemplateSchema,
  fieldNamesForStep,
  toEmployeePayloads,
} from '@/components/dynamic-form/buildTemplateSchema';
import { FieldOptionSources } from '@/components/dynamic-form/Field';
import { TemplateField } from '@/types/profile-template';
import { applyServerErrors } from '@/lib/applyServerErrors';
import { getApiErrorMessage } from '@/lib/apiError';
import { formatCurrency, getCurrencySymbol, getCurrencyCode } from '@/utils/formatters';
import {
  PAY_BASIS_OPTIONS,
  basisHelperText,
  estimatedWorkDaysPerMonth,
  monthlyEquivalent,
  payBasisForEmploymentType,
  payBasisLabel,
  toSalaryBasis,
} from '@/utils/payBasis';

// ─── Schema ────────────────────────────────────────────────────────────────────

// Phone: digits only, configured length window (business rule).
const PHONE_MIN_DIGITS = 10;
const PHONE_MAX_DIGITS = 15;

// The hand-written employee schema that used to live here is gone: it had
// already drifted from the edit form's copy (this one required `branchId` and
// enforced a phone pattern; the other did neither). Both now derive from the
// active template via buildTemplateSchema, so they cannot disagree again.

// ─── Local types ───────────────────────────────────────────────────────────────

type SalaryRow = { uid: string; componentType: string; amount: string; note: string };

// The type list is NOT hardcoded here any more: it comes from the
// SALARY_COMPONENT_TYPE library, same as every other screen that edits a salary
// structure. A hardcoded copy meant an admin who added HRA to the library still
// could not pick it while onboarding, and the list below silently disagreed
// with the one on the employee's own salary tab.

interface PayrollConfig {
  currencySymbol: string;
  pfEnabled: boolean;
  pfEmployeeRate: number;
  pfSalaryCap: number;
  pfLabel: string;
  esiEnabled: boolean;
  esiEmployeeRate: number;
  esiSalaryCap: number;
  esiLabel: string;
  professionalTaxEnabled: boolean;
  professionalTaxSlabs: { upTo: number; tax: number }[];
  taxEnabled: boolean;
  taxRegime: string;
  standardDeduction: number;
  taxRebateEnabled: boolean;
  taxRebateLimit: number;
  cessEnabled: boolean;
  cessRate: number;
  taxLabel: string;
  taxBrackets: { limit: number; rate: number }[];
  /** Configured work week, used to monthly-ise a day rate for the statutory preview. */
  workDaysPerWeek: number;
  /** When false, daily-wage staff take no statutory deductions at all. */
  dailyWageStatutoryDeductions: boolean;
}

const DEFAULT_PAYROLL_CONFIG: PayrollConfig = {
  workDaysPerWeek: 5,
  dailyWageStatutoryDeductions: true,
  currencySymbol: '₹',
  pfEnabled: false, pfEmployeeRate: 0.12, pfSalaryCap: 15000,
  pfLabel: 'EPF (Employee Provident Fund)',
  esiEnabled: false, esiEmployeeRate: 0.0075, esiSalaryCap: 21000,
  esiLabel: 'ESI (Employee State Insurance)',
  professionalTaxEnabled: false,
  professionalTaxSlabs: [
    { upTo: 10000, tax: 0 }, { upTo: 15000, tax: 110 },
    { upTo: 20000, tax: 130 }, { upTo: 25000, tax: 150 },
    { upTo: 999999999, tax: 200 },
  ],
  taxEnabled: true, taxRegime: 'new', standardDeduction: 75000,
  taxRebateEnabled: true, taxRebateLimit: 700000,
  cessEnabled: true, cessRate: 0.04,
  taxLabel: 'Income Tax / TDS',
  taxBrackets: [
    { limit: 300000, rate: 0 }, { limit: 700000, rate: 0.05 },
    { limit: 1000000, rate: 0.1 }, { limit: 1200000, rate: 0.15 },
    { limit: 1500000, rate: 0.2 }, { limit: 999999999, rate: 0.3 },
  ],
};

function applyBrackets(income: number, brackets: { limit: number; rate: number }[]): number {
  let tax = 0, remaining = income, prev = 0;
  for (const b of brackets) {
    const slice = Math.min(remaining, b.limit - prev);
    if (slice <= 0) break;
    tax += slice * b.rate;
    remaining -= slice;
    prev = b.limit;
  }
  return tax;
}

/**
 * Estimated statutory deductions for one month.
 *
 * PF/ESI caps and PT slabs are all MONTHLY thresholds, so a daily-wage
 * employee's per-period figures are monthly-ised first — comparing a 800/day
 * rate against a 15,000 PF cap would otherwise wildly understate the deduction.
 * The cap/slab math below is deliberately untouched.
 *
 * This is an estimate: it assumes a full month of work. The payslip always uses
 * days actually worked.
 */
function calcPreview(
  grossPerPeriod: number,
  basicPerPeriod: number,
  cfg: PayrollConfig,
  basis: 'MONTHLY' | 'DAILY' = 'MONTHLY',
  estWorkDaysPerMonth = 22,
) {
  const grossSalary = monthlyEquivalent(basis, grossPerPeriod, estWorkDaysPerMonth);
  const basicSalary = monthlyEquivalent(basis, basicPerPeriod, estWorkDaysPerMonth);
  let pf = 0;
  if (cfg.pfEnabled && basicSalary > 0) {
    const base = cfg.pfSalaryCap > 0 ? Math.min(basicSalary, cfg.pfSalaryCap) : basicSalary;
    pf = base * cfg.pfEmployeeRate;
  }
  let esi = 0;
  if (cfg.esiEnabled && grossSalary > 0 && (cfg.esiSalaryCap <= 0 || grossSalary <= cfg.esiSalaryCap)) {
    esi = grossSalary * cfg.esiEmployeeRate;
  }
  let pt = 0;
  if (cfg.professionalTaxEnabled && cfg.professionalTaxSlabs?.length > 0) {
    for (const s of cfg.professionalTaxSlabs) {
      if (grossSalary <= s.upTo) { pt = s.tax; break; }
    }
    if (pt === 0 && grossSalary > 0) pt = cfg.professionalTaxSlabs[cfg.professionalTaxSlabs.length - 1]?.tax ?? 0;
  }
  const insurance = pf + esi;
  let tax = 0;
  if (cfg.taxEnabled && grossSalary > 0) {
    const annualGross = grossSalary * 12;
    const taxable = Math.max(0, annualGross - insurance * 12 - cfg.standardDeduction);
    let annualTax = applyBrackets(taxable, cfg.taxBrackets);
    if (cfg.taxRebateEnabled && taxable <= cfg.taxRebateLimit) annualTax = 0;
    if (cfg.cessEnabled && annualTax > 0) annualTax *= (1 + cfg.cessRate);
    tax = annualTax / 12;
  }
  const totalDeductions = insurance + pt + tax;
  return {
    pf: Math.round(pf), esi: Math.round(esi), pt: Math.round(pt), tax: Math.round(tax),
    totalDeductions: Math.round(totalDeductions),
    netSalary: Math.round(grossSalary - totalDeductions),
  };
}

// ─── Style helpers ─────────────────────────────────────────────────────────────

/**
 * Filled by the server from the department; the form only previews them.
 *
 * Kept separate from the read-only list, which also carries `salaryType` when
 * an employment type locks it — that one is read-only because it is DERIVED
 * FROM ANOTHER ANSWER, not because the system generates it, and it is not
 * required, so conflating the two would quietly drop a rule that should stay.
 */
const DERIVED_FIELD_KEYS = ['employeeCode', 'idCard'];

const fieldCls = (err?: boolean) =>
  `w-full px-3.5 py-2.5 text-sm border rounded-[--radius-input] bg-surface-card text-text-body
  focus:outline-none focus:ring-2 transition-colors
  ${err
    ? 'border-status-error focus:ring-status-error/20'
    : 'border-surface-border hover:border-brand-primary/50 focus:ring-brand-primary/20'
  }`;

const readonlyCls =
  'w-full px-3.5 py-2.5 text-sm border border-surface-border rounded-[--radius-input] bg-surface-page text-text-muted cursor-not-allowed';

const labelCls = 'block text-sm font-medium text-text-heading mb-1.5';
const errCls = 'mt-1 text-xs text-status-error flex items-center gap-1';

// ─── Review row helper ─────────────────────────────────────────────────────────

function InfoRow({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value?: string | null }) {
  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-surface-border last:border-0">
      <div className="w-8 h-8 rounded-lg bg-brand-primary/8 flex items-center justify-center shrink-0 mt-0.5">
        <Icon size={15} className="text-brand-primary" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-text-muted font-medium uppercase tracking-wide">{label}</p>
        <p className="text-sm text-text-body font-medium mt-0.5 truncate">{value || '—'}</p>
      </div>
    </div>
  );
}

function ReviewSection({ title, icon: Icon, children }: { title: string; icon: React.ElementType; children: React.ReactNode }) {
  return (
    <div className="bg-surface-page rounded-xl border border-surface-border overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 bg-brand-primary/5 border-b border-surface-border">
        <Icon size={16} className="text-brand-primary" />
        <h3 className="text-sm font-semibold text-text-heading">{title}</h3>
      </div>
      <div className="px-4 divide-y divide-surface-border">
        {children}
      </div>
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

export default function EmployeeOnboardingStepper() {
  const router = useRouter();
  const t = useTranslations('employeeOnboardingStepper');
  // Shared pay-basis strings, consumed by utils/payBasis.ts helpers.
  const tp = useTranslations('payBasis');
  const tc = useTranslations('common');

  // The one heading for this route, rendered by TopHeader.
  usePageHeader(t('title'), t('subtitle'));

  const STEPS = useMemo(() => [
    { id: 1, label: t('stepPersonalInfoName'), icon: User, desc: t('stepPersonalInfoDesc') },
    { id: 2, label: t('stepEmploymentName'), icon: Briefcase, desc: t('stepEmploymentDesc') },
    { id: 3, label: t('stepContractName'), icon: FileText, desc: t('stepContractDesc') },
    { id: 4, label: t('stepPayrollName'), icon: CurrencyIcon, desc: t('stepPayrollDesc') },
    { id: 5, label: t('stepReviewName'), icon: ClipboardList, desc: t('stepReviewDesc') },
  ], [t]);
  const [step, setStep] = useState(1);
  const [done, setDone] = useState<Set<number>>(new Set());
  const [departments, setDepartments] = useState<Department[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const selectedBranchId = useBranchStore((s) => s.selectedBranchId);
  const [positions, setPositions] = useState<any[]>([]);
  // Full library items: an EMPLOYMENT_TYPE item's payBasis fixes (and locks) the
  // employee's Pay Basis.
  const [employmentTypes, setEmploymentTypes] = useState<LibraryItem[]>([]);
  const [otPolicies, setOtPolicies] = useState<{ id: string; name: string; isActive: boolean }[]>([]);
  const [salaryRows, setSalaryRows] = useState<SalaryRow[]>([]);
  const [componentOptions, setComponentOptions] = useState<SalaryComponentTypeOption[]>(SALARY_COMPONENT_OPTIONS);
  const [payrollConfig, setPayrollConfig] = useState<PayrollConfig>(DEFAULT_PAYROLL_CONFIG);
  const [empPfEnabled, setEmpPfEnabled] = useState<boolean | null>(null);
  const [empEsiEnabled, setEmpEsiEnabled] = useState<boolean | null>(null);
  const [empPtEnabled, setEmpPtEnabled] = useState<boolean | null>(null);
  const [showPayrollPreview, setShowPayrollPreview] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [direction, setDirection] = useState(1);
  const skipDeptEffect = useRef(false);
  const prevContractOn = useRef(false);
  const { confirm, ConfirmDialog, closeModal, setLoading: setConfirmLoading } = useConfirm();
  // Picker hints only — the server holds the real policy.
  const startDateBounds = useStartDateBounds();

  // Steps 1-2 render from the active template; the schema follows it, which is
  // what stops this form and the edit form from drifting apart again.
  const { data: template } = useProfileTemplate({ mode: 'CREATE' });
  const templateFields = useMemo<TemplateField[]>(() => template?.fields ?? [], [template]);
  const templateSchema = useMemo(
    () =>
      (buildTemplateSchema(templateFields, {
        // Both are generated from the department on step 2, and rendered
        // read-only. Requiring them on step 1 made the wizard impossible to
        // finish: the user was asked for a value they could not type and
        // whose source they had not reached yet.
        derivedFields: DERIVED_FIELD_KEYS,
      }) as z.ZodObject<any>).extend({
        initialContract: z
          .object({
            enabled: z.boolean().default(false),
            contractType: z.enum(['PROBATION', 'FIXED_TERM', 'INDEFINITE']).optional(),
            workType: z.enum(['FULL_TIME', 'PART_TIME']).optional(),
            workHoursPerWeek: z.string().optional(),
            startDate: z.string().optional(),
            endDate: z.string().optional().nullable(),
            notes: z.string().optional(),
          })
          .optional(),
      }),
    [templateFields],
  );

  const form = useForm<any>({
    resolver: zodResolver(templateSchema as any) as any,
    defaultValues: {
      salaryType: 'MONTHLY',
      customFields: {},
      initialContract: { enabled: false, workType: 'FULL_TIME' },
    },
  });
  const {
    register,
    formState: { errors },
    watch,
    setValue,
    setError,
    trigger,
    getValues,
  } = form;

  const deptId = watch('departmentId');
  const contractOn = watch('initialContract.enabled');
  const contractType = watch('initialContract.contractType');
  const workType = watch('initialContract.workType');
  const baseSalary = watch('baseSalary');
  const salaryType = watch('salaryType');
  const employmentType = watch('employmentType');

  // ── Employment Type -> Pay Basis ───────────────────────────────────────────
  // A library item flagged MONTHLY/DAILY dictates the pay basis and locks the
  // select; an unflagged one leaves the choice to HR. The server derives the
  // same rule on save, so this only mirrors it.
  const lockedBasis = payBasisForEmploymentType(employmentTypes, employmentType);
  const isDaily = salaryType === 'DAILY';

  useEffect(() => {
    if (lockedBasis && lockedBasis !== getValues('salaryType')) {
      setValue('salaryType', lockedBasis, { shouldValidate: true, shouldDirty: true });
    }
     
  }, [lockedBasis]);

  // ── Data fetching ────────────────────────────────────────────────────────────

  useEffect(() => {
    (async () => {
      try {
        const [deptRes, posRes, settingsRes, branchRes, ctRes, otRes, scRes] = await Promise.all([
          departmentService.getAll(),
          libraryService.getAll('POSITION', true),
          systemSettingsService.getAll().catch(() => null),
          branchService.getAll().catch(() => null),
          libraryService.getAll('EMPLOYMENT_TYPE', true).catch(() => null),
          overtimePolicyService.list().catch(() => null),
          libraryService.getAll('SALARY_COMPONENT_TYPE', true).catch(() => null),
        ]);
        if ((ctRes as any)?.data) setEmploymentTypes((ctRes as any).data as LibraryItem[]);
        if ((scRes as any)?.data) setComponentOptions(optionsFromLibrary((scRes as any).data));
        if ((otRes as any)?.data) setOtPolicies((otRes as any).data);
        if (deptRes?.data) setDepartments(deptRes.data);
        if (branchRes?.data) {
          setBranches(branchRes.data);
          // Default the new hire into the branch the admin is currently viewing.
          if (selectedBranchId && !getValues('branchId')) {
            setValue('branchId', selectedBranchId);
          }
        }
        if (posRes?.success) setPositions(posRes.data);
        if ((settingsRes as any)?.success) {
          const find = (key: string) => (settingsRes as any).data.find((s: any) => s.key === key)?.value ?? '';
          const tryJSON = <T,>(raw: string, fb: T): T => { try { return JSON.parse(raw) as T; } catch { return fb; } };
          const country = find('payroll_country') || 'IN';
          const LABELS: Record<string, { pf: string; esi: string; tax: string }> = {
            IN: { pf: 'EPF (Employee Provident Fund)', esi: 'ESI (Employee State Insurance)', tax: 'Income Tax / TDS' },
            US: { pf: 'FICA (Social Security + Medicare)', esi: 'Healthcare Benefit', tax: 'Federal Income Tax' },
            GB: { pf: 'National Insurance (NI)', esi: 'NHS Contribution', tax: 'Income Tax (PAYE)' },
            AE: { pf: 'GPSSA', esi: 'Health Insurance', tax: 'Income Tax' },
            OM: { pf: 'SPF (Social Protection Fund)', esi: 'Health Insurance', tax: 'Income Tax' },
            SG: { pf: 'CPF (Central Provident Fund)', esi: 'Medisave', tax: 'Income Tax' },
            DE: { pf: 'Sozialversicherung', esi: 'Krankenversicherung', tax: 'Einkommensteuer' },
          };
          const lbl = LABELS[country] ?? LABELS['IN'];
          setPayrollConfig({
            currencySymbol: find('payroll_currency_symbol') || '₹',
            pfEnabled: find('payroll_pf_enabled') !== 'false',
            pfEmployeeRate: parseFloat(find('payroll_pf_employee_rate') || '0.12'),
            pfSalaryCap: parseFloat(find('payroll_pf_salary_cap') || '15000'),
            pfLabel: find('payroll_label_pf')?.trim() || lbl.pf,
            esiEnabled: find('payroll_esi_enabled') !== 'false',
            esiEmployeeRate: parseFloat(find('payroll_esi_employee_rate') || '0.0075'),
            esiSalaryCap: parseFloat(find('payroll_esi_salary_cap') || '21000'),
            esiLabel: find('payroll_label_esi')?.trim() || lbl.esi,
            professionalTaxEnabled: find('payroll_professional_tax_enabled') !== 'false',
            professionalTaxSlabs: tryJSON(find('payroll_professional_tax_slabs'), DEFAULT_PAYROLL_CONFIG.professionalTaxSlabs),
            taxEnabled: true,
            taxRegime: find('payroll_tax_regime') || 'new',
            standardDeduction: parseFloat(find('payroll_standard_deduction') || '75000'),
            taxRebateEnabled: find('payroll_tax_rebate_enabled') !== 'false',
            taxRebateLimit: parseFloat(find('payroll_tax_rebate_limit') || '700000'),
            cessEnabled: find('payroll_cess_enabled') !== 'false',
            cessRate: parseFloat(find('payroll_cess_rate') || '0.04'),
            taxLabel: find('payroll_label_income_tax')?.trim() || lbl.tax,
            taxBrackets: tryJSON(find('payroll_tax_brackets'), DEFAULT_PAYROLL_CONFIG.taxBrackets),
            workDaysPerWeek: parseFloat(find('payroll_work_days_per_week') || '5'),
            dailyWageStatutoryDeductions:
              find('payroll_daily_wage_statutory_deductions') !== 'false',
          });
        }
      } catch (e) {
        console.error('Failed to load master data:', e);
      }
    })();
  }, []);

  // ── Auto-generate employee code on dept change ───────────────────────────────

  useEffect(() => {
    if (skipDeptEffect.current) { skipDeptEffect.current = false; return; }
    if (deptId) {
      employeeService.generateCode(deptId).then(res => {
        if (res?.success && res.data?.employeeCode) {
          setValue('employeeCode', res.data.employeeCode);
          setValue('idCard', res.data.employeeCode);
        }
      }).catch(() => {});
    } else {
      setValue('employeeCode', '');
      setValue('idCard', '');
    }
  }, [deptId, setValue]);

  // ── Pre-fill contract start date from employment start date ──────────────────

  useEffect(() => {
    if (contractOn && !prevContractOn.current) {
      const empStart = watch('startDate');
      if (empStart) setValue('initialContract.startDate', empStart);
    }
    prevContractOn.current = !!contractOn;
  }, [contractOn]);

  // ── Salary rows ──────────────────────────────────────────────────────────────

  const addRow = () => {
    setSalaryRows(r => [
      ...r,
      { uid: Date.now().toString(), componentType: componentOptions[0].value, amount: '', note: '' },
    ]);
  };

  const removeRow = (uid: string) => setSalaryRows(r => r.filter(x => x.uid !== uid));

  const updateRow = (uid: string, key: keyof SalaryRow, val: string) =>
    setSalaryRows(r => r.map(x => (x.uid === uid ? { ...x, [key]: val } : x)));

  const salaryTotal = salaryRows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);

  // ── Step validation ──────────────────────────────────────────────────────────

  const validateContract = (): boolean => {
    if (!contractOn) return true;
    const c = getValues('initialContract');
    let ok = true;
    if (!c?.contractType) {
      setError('initialContract.contractType' as any, { message: t('contractTypeRequired') });
      ok = false;
    }
    if (!c?.startDate) {
      setError('initialContract.startDate' as any, { message: t('contractStartDateRequired') });
      ok = false;
    }
    if (c?.contractType && c.contractType !== 'INDEFINITE' && !c.endDate) {
      setError('initialContract.endDate' as any, { message: t('contractEndDateRequired') });
      ok = false;
    }
    if (c?.workType === 'PART_TIME' && (!c.workHoursPerWeek || parseInt(c.workHoursPerWeek) < 1)) {
      setError('initialContract.workHoursPerWeek' as any, { message: t('hoursPerWeekRequired') });
      ok = false;
    }
    return ok;
  };

  const validatePayroll = (): boolean => {
    for (const row of salaryRows) {
      const amt = parseFloat(row.amount);
      if (!row.amount || isNaN(amt) || amt <= 0) {
        toast.error(t('componentAmountRequired'));
        return false;
      }
    }
    return true;
  };

  const advance = async () => {
    let ok = true;
    // Which fields gate a step is template data now, not a list hardcoded here
    // — the two used to drift, so a field made required in the template would
    // still let the user walk past it.
    if (step === 1 || step === 2) {
      const names = fieldNamesForStep(template?.sections ?? [], step);
      ok = names.length === 0 || (await trigger(names as any));
    }
    if (step === 3) ok = validateContract();
    if (step === 4) ok = validatePayroll();
    if (ok) {
      setDirection(1);
      setDone(s => new Set([...s, step]));
      setStep(s => Math.min(s + 1, STEPS.length));
    }
  };

  const goBack = () => {
    setDirection(-1);
    setStep(s => Math.max(s - 1, 1));
  };

  // ── Final submit ─────────────────────────────────────────────────────────────

  const handleSubmit = async () => {
    const data = getValues();
    const confirmed = await confirm({
      title: t('confirmCreateTitle'),
      message: t('confirmCreateDesc', { name: data.fullName }),
      confirmText: t('createEmployeeBtn'),
      type: 'info',
    });
    if (!confirmed) return;

    setSubmitting(true);
    setConfirmLoading(true);

    try {
      // 1. Create employee. Built from the template rather than a hand-listed
      // set, so a field an admin adds is actually submitted.
      const { initialContract: _contract, ...formValues } = data as Record<string, unknown>;
      // Split by table: EmployeeProfile columns (place of birth, nationality,
      // emergency contact…) are rejected by the employee endpoint under
      // `forbidNonWhitelisted`, so they go to the profile endpoint after the
      // employee exists.
      const { employee: employeeValues, profile: profileValues } = toEmployeePayloads(
        formValues,
        templateFields,
        // Create: an untouched optional field has nothing to clear, so the key
        // is left out rather than sent as '' — which @IsOptional() does not
        // skip and every strict validator then rejects.
        { emptyValues: 'omit' },
      );
      const createPayload: any = {
        ...employeeValues,
        // idCard is mirrored from the generated employee code and the server
        // re-generates both on a collision — see autoGenerateIdCard's contract.
        autoGenerateIdCard: true,
      };
      // Omitted when the employment type fixes it: the server derives the basis
      // and rejects a contradicting value.
      if (lockedBasis) delete createPayload.salaryType;
      // Server-generated from the department; the form only previews it.
      delete createPayload.employeeCode;
      const empRes = await employeeService.create(createPayload);
      const newId = empRes.data?.id;

      let contractFailed = false;
      let payrollFailed = false;

      // 1b. Save the EmployeeProfile half. Non-fatal: the employee already
      // exists, and losing the wizard's state over a nationality would be worse
      // than reporting the one failed call.
      if (newId && Object.keys(profileValues).length) {
        try {
          await employeeProfileService.updateProfile(newId, profileValues);
        } catch (err: any) {
          console.error('Onboarding: profile save failed', err?.response?.data || err);
          toast.error(t('profileSaveFailed'));
        }
      }

      // 2. Create contract
      if (data.initialContract?.enabled && newId && data.initialContract.contractType && data.initialContract.startDate) {
        try {
          await contractService.create({
            employeeId: newId,
            contractType: data.initialContract.contractType,
            startDate: data.initialContract.startDate,
            endDate: data.initialContract.endDate || undefined,
            salary: Number(data.baseSalary) || 0,
            workType: data.initialContract.workType || 'FULL_TIME',
            workHoursPerWeek: data.initialContract.workHoursPerWeek
              ? parseInt(data.initialContract.workHoursPerWeek)
              : 40,
            notes: data.initialContract.notes || undefined,
          });
        } catch (err: any) {
          console.error('Onboarding: contract creation failed', err?.response?.data || err);
          contractFailed = true;
        }
      }

      // 3. Create salary components
      if (salaryRows.length > 0 && newId) {
        try {
          await Promise.all(
            salaryRows.map(row =>
              salaryComponentService.create({
                employeeId: newId,
                componentType: toComponentCode(row.componentType),
                amount: parseFloat(row.amount),
                note: row.note || undefined,
              })
            )
          );
        } catch (err: any) {
          console.error('Onboarding: salary component creation failed', err?.response?.data || err);
          payrollFailed = true;
        }
      }

      // 4. Save deduction overrides as PAYROLL_CONFIG component
      if (newId && (empPfEnabled !== null || empEsiEnabled !== null || empPtEnabled !== null)) {
        try {
          const overrides: Record<string, boolean> = {};
          if (empPfEnabled !== null) overrides.pfEnabled = empPfEnabled;
          if (empEsiEnabled !== null) overrides.esiEnabled = empEsiEnabled;
          if (empPtEnabled !== null) overrides.professionalTaxEnabled = empPtEnabled;
          await salaryComponentService.create({
            employeeId: newId,
            componentType: 'PAYROLL_CONFIG' as any,
            amount: 0,
            note: JSON.stringify(overrides),
          });
        } catch (err: any) {
          console.error('Onboarding: payroll override creation failed', err?.response?.data || err);
          payrollFailed = true;
        }
      }

      closeModal();

      if (!contractFailed && !payrollFailed) {
        toast.success(t('onboardSuccess'));
      } else {
        toast.success(t('createSuccess'));
        if (contractFailed) toast.error(t('contractSetupFailed'));
        if (payrollFailed) toast.error(t('componentsFailed'));
      }

      router.push('/dashboard/employees');
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.message || t('genericError');
      toast.error(msg);
      setConfirmLoading(false);
      setSubmitting(false);
    }
  };

  // ─── Shared payroll preview computation ─────────────────────────────────────

  const baseAmount = baseSalary && Number(baseSalary) > 0 ? Number(baseSalary) : 0;
  const previewGross = baseAmount + salaryTotal;
  const previewBasic = (() => {
    const basicRow = salaryRows.find(r => r.componentType.toLowerCase().includes('basic'));
    return basicRow ? parseFloat(basicRow.amount) || 0 : (baseSalary ? Number(baseSalary) || 0 : 0);
  })();
  const effectiveCfg: PayrollConfig = {
    ...payrollConfig,
    pfEnabled: empPfEnabled !== null ? empPfEnabled : payrollConfig.pfEnabled,
    esiEnabled: empEsiEnabled !== null ? empEsiEnabled : payrollConfig.esiEnabled,
    professionalTaxEnabled: empPtEnabled !== null ? empPtEnabled : payrollConfig.professionalTaxEnabled,
  };
  // A daily rate has to be turned into a monthly figure before it can be
  // compared against monthly PF/ESI caps and PT slabs.
  const estWorkDaysPerMonth = estimatedWorkDaysPerMonth(payrollConfig.workDaysPerWeek);
  // When statutory deductions are switched off for daily-wage staff, the engine
  // takes none — so the preview must not promise any.
  const statutoryApplies = !isDaily || payrollConfig.dailyWageStatutoryDeductions;
  const payrollPreview = statutoryApplies
    ? calcPreview(previewGross, previewBasic, effectiveCfg, salaryType, estWorkDaysPerMonth)
    : { pf: 0, esi: 0, pt: 0, tax: 0, totalDeductions: 0, netSalary: Math.round(previewGross) };

  // ─── Step renderers ──────────────────────────────────────────────────────────

  // Option sets for the template's relation-shaped and library-backed selects.
  const templateOptionSources: FieldOptionSources = useMemo(
    () => ({
      DEPARTMENT: departmentPickerOptions(departments),
      BRANCH: branches.map(b => ({
        value: b.id,
        label: b.code ? `${b.name} (${b.code})` : b.name,
      })),
      POSITION: positions.map((p: any) => ({ value: p.label, label: p.label })),
      EMPLOYMENT_TYPE: employmentTypes.map((e: any) => ({ value: e.label, label: e.label })),
      overtimePolicyId: otPolicies.map(p => ({ value: p.id, label: p.name })),
    }),
    [departments, branches, positions, employmentTypes, otPolicies],
  );

  // Server-generated, or fixed by the employment type — never typed over.
  const templateReadOnlyFields = useMemo(() => {
    const ro = ['employeeCode', 'idCard'];
    if (lockedBasis) ro.push('salaryType');
    return ro;
  }, [lockedBasis]);

  /** The timezone picker is a grouped searchable widget, not a plain select. */
  const renderTemplateField = (field: TemplateField) => {
    // Picker bounds from the employment start-date policy. Hints only — the
    // server enforces — but without them the calendar offers dates the save
    // will refuse. main added these to the hand-written input this wizard
    // replaced, so they are re-applied rather than lost to the rewrite.
    if (field.fieldKey === 'startDate') {
      return (
        <>
          <label className={labelCls}>
            {field.label}
            {field.required && <span className="text-status-error"> *</span>}
          </label>
          <input
            {...register('startDate')}
            type="date"
            min={startDateBounds.min}
            max={startDateBounds.max}
            className={fieldCls(!!errors.startDate)}
          />
          <p className="mt-1 text-xs text-text-secondary">{t('startDateHint')}</p>
        </>
      );
    }

    /** The timezone picker is a grouped searchable widget, not a plain select. */
    if (field.fieldKey !== 'timezone') return undefined;
    return (
      <>
        <label className={labelCls}>
          {field.label}{' '}
          <span className="text-xs font-normal text-text-muted">{t('timezoneRemoteSuffix')}</span>
        </label>
        <TimezoneSelect
          value={watch('timezone') ?? ''}
          onChange={tz => setValue('timezone', tz || null)}
          includeInherit
        />
        <p className="mt-1 text-xs text-text-muted">{t('timezoneHelper')}</p>
      </>
    );
  };

  // ─── Steps 1 & 2: template-driven ────────────────────────────────────────
  // These used to be two hand-written arrays of ~25 JSX field blocks. Which
  // fields appear, their labels, order and grouping now come from the active
  // Employee Profile Template, so an admin can change the onboarding form
  // without a deploy. Steps 3-5 (contract, payroll, review) stay hand-written:
  // they edit other entities, not the employee profile.
  const renderTemplateStep = (wizardStep: number) => {
    if (!template) return null;
    const sections = template.sections.filter(s => s.wizardStep === wizardStep);
    if (!sections.length) return null;

    return (
      <div className="space-y-6">
        {sections.map((section, si) => (
          <motion.div
            key={section.sectionKey}
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.28, delay: si * 0.05, ease: 'easeOut' }}
          >
            <TemplateFormRenderer
              template={{ ...template, sections: [section] }}
              form={form}
              readOnlyFields={templateReadOnlyFields}
              optionSources={templateOptionSources}
              renderField={renderTemplateField}
            />
          </motion.div>
        ))}
      </div>
    );
  };

  const renderStep1 = () => renderTemplateStep(1);
  const renderStep2 = () => renderTemplateStep(2);


  const renderStep3 = () => (
    <div className="space-y-6">
      {/* Toggle */}
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, delay: 0, ease: 'easeOut' }}
        className="flex items-start gap-4 p-4 rounded-xl border border-surface-border bg-surface-page"
      >
        <div className="relative mt-0.5">
          <input
            type="checkbox"
            id="contract-toggle"
            {...register('initialContract.enabled')}
            className="sr-only peer"
          />
          <label
            htmlFor="contract-toggle"
            className="flex w-11 h-6 bg-surface-border rounded-full cursor-pointer
              peer-checked:bg-brand-primary transition-colors relative
              after:content-[''] after:absolute after:top-0.5 after:left-0.5
              after:w-5 after:h-5 after:bg-white after:rounded-full after:shadow
              after:transition-transform peer-checked:after:translate-x-5"
          />
        </div>
        <div>
          <p className="text-sm font-semibold text-text-heading">{t('createContractToggle')}</p>
          <p className="text-xs text-text-muted mt-0.5">{t('createContractDesc')}</p>
        </div>
      </motion.div>

      <AnimatePresence>
        {contractOn && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-5">
              {[
                <div key="ct">
                  <label className={labelCls}>{t('contractTypeLabel')} <span className="text-status-error">*</span></label>
                  <select
                    {...register('initialContract.contractType')}
                    className={fieldCls(!!(errors.initialContract as any)?.contractType)}
                  >
                    <option value="">{t('selectContractType')}</option>
                    <option value="PROBATION">{t('contractProbation')}</option>
                    <option value="FIXED_TERM">{t('contractFixedTerm')}</option>
                    <option value="INDEFINITE">{t('contractIndefinite')}</option>
                  </select>
                  {(errors.initialContract as any)?.contractType && (
                    <p className={errCls}>{(errors.initialContract as any).contractType.message}</p>
                  )}
                </div>,
                <div key="wt">
                  <label className={labelCls}>{t('workModeLabel')}</label>
                  <select {...register('initialContract.workType')} className={fieldCls()}>
                    <option value="FULL_TIME">{t('workModeFullTime')}</option>
                    <option value="PART_TIME">{t('workModePartTime')}</option>
                  </select>
                </div>,
                ...(workType === 'PART_TIME' ? [
                  <div key="hours">
                    <label className={labelCls}>{t('hoursPerWeekLabel')} <span className="text-status-error">*</span></label>
                    <input
                      {...register('initialContract.workHoursPerWeek')}
                      type="number"
                      min={1}
                      max={39}
                      onWheel={e => e.currentTarget.blur()}
                      placeholder={t('hoursPerWeekPlaceholder')}
                      className={fieldCls(!!(errors.initialContract as any)?.workHoursPerWeek)}
                    />
                    {(errors.initialContract as any)?.workHoursPerWeek && (
                      <p className={errCls}>{(errors.initialContract as any).workHoursPerWeek.message}</p>
                    )}
                  </div>,
                ] : []),
                <div key="sd">
                  <label className={labelCls}>{t('contractStartDateLabel')} <span className="text-status-error">*</span></label>
                  <input
                    {...register('initialContract.startDate')}
                    type="date"
                    min={startDateBounds.min}
                    max={startDateBounds.max}
                    className={fieldCls(!!(errors.initialContract as any)?.startDate)}
                  />
                  <p className="mt-1 text-xs text-text-secondary">{t('startDateHint')}</p>
                  {(errors.initialContract as any)?.startDate && (
                    <p className={errCls}>{(errors.initialContract as any).startDate.message}</p>
                  )}
                </div>,
                ...(contractType !== 'INDEFINITE' ? [
                  <div key="ed">
                    <label className={labelCls}>
                      {t('contractEndDateLabel')}{' '}
                      {contractType && <span className="text-status-error">*</span>}
                    </label>
                    <input
                      {...register('initialContract.endDate')}
                      type="date"
                      className={fieldCls(!!(errors.initialContract as any)?.endDate)}
                    />
                    {(errors.initialContract as any)?.endDate && (
                      <p className={errCls}>{(errors.initialContract as any).endDate.message}</p>
                    )}
                  </div>,
                ] : []),
                <div key="notes" className="col-span-full">
                  <label className={labelCls}>{t('notesLabel')} <span className="text-xs font-normal text-text-muted">{t('optionalSuffix')}</span></label>
                  <textarea
                    {...register('initialContract.notes')}
                    rows={2}
                    placeholder={t('notesPlaceholder')}
                    className={`${fieldCls()} resize-none`}
                  />
                </div>,
                <div key="salary-notice" className="col-span-full">
                  <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-brand-primary/5 border border-brand-primary/20 text-sm text-text-body">
                    <CurrencyIcon size={15} className="text-brand-primary shrink-0" />
                    <span>
                      {t('contractSalaryNote')}
                      {baseSalary && Number(baseSalary) > 0
                        ? t('contractSalaryAmount', {
                            amount: `${formatCurrency(Number(baseSalary))}${isDaily ? tp('perDay') : ''}`,
                          })
                        : t('contractSalaryMissing')}
                    </span>
                  </div>
                </div>,
              ].map((field, i) => (
                <motion.div
                  key={field.key}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25, delay: i * 0.05, ease: 'easeOut' }}
                  className={(field.props as any).className?.includes('col-span-full') ? 'col-span-full' : ''}
                >
                  {field}
                </motion.div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {!contractOn && (
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="text-sm text-text-muted text-center py-6"
          >
            {t('toggleContractHint')}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );

  const renderStep4 = () => {
    const grossSalary = previewGross;
    const preview = payrollPreview;
    const hasOverride = empPfEnabled !== null || empEsiEnabled !== null || empPtEnabled !== null;

    return (
      <div className="space-y-6">
        {isDaily && (
          <div className="px-4 py-2.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800 font-medium">
            {t('componentsArePerDayBanner')}
          </div>
        )}
        {/* ── Salary Components ────────────────────────────── */}
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.28, delay: 0, ease: 'easeOut' }}
          className="space-y-3"
        >
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-text-heading">{t('salaryComponentsHeading')}</h3>
              <p className="text-xs text-text-muted mt-0.5">{t('salaryComponentsDesc')}</p>
            </div>
            <button
              type="button"
              onClick={addRow}
              className="flex items-center gap-2 px-4 py-2 bg-brand-primary text-text-on-brand rounded-[--radius-button]
                hover:bg-brand-primary-dark transition-all text-sm font-medium shadow-sm shrink-0"
            >
              <Plus size={15} /> {t('addComponent')}
            </button>
          </div>

          {/* Base salary reference */}
          {baseSalary && Number(baseSalary) > 0 && (
            <div className="flex items-center justify-between px-4 py-2.5 rounded-lg bg-surface-page border border-surface-border">
              <div className="flex items-center gap-2 text-sm text-text-muted">
                <CurrencyIcon size={14} className="text-brand-primary" />
                <span>{t('baseSalaryFromEmployment')}</span>
              </div>
              <span className="text-sm font-semibold text-text-heading">{formatCurrency(Number(baseSalary))}</span>
            </div>
          )}

          {salaryRows.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 border-2 border-dashed border-surface-border rounded-xl text-text-muted gap-3">
              <CurrencyIcon size={28} className="opacity-30" />
              <p className="text-sm">{t('noComponentsAdded')}</p>
              <button type="button" onClick={addRow} className="text-sm text-brand-primary hover:underline font-medium">
                {t('addFirstComponent')}
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="grid grid-cols-[1fr_160px_1fr_40px] gap-3 px-3 pb-1">
                <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">{t('colComponentType')}</span>
                <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">{t('colAmount')} ({getCurrencyCode()})</span>
                <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">{t('colNote')}</span>
                <span />
              </div>
              {salaryRows.map(row => (
                <div key={row.uid} className="grid grid-cols-[1fr_160px_1fr_40px] gap-3 items-center p-3 bg-surface-page rounded-lg border border-surface-border">
                  <select value={row.componentType} onChange={e => updateRow(row.uid, 'componentType', e.target.value)} className={fieldCls()}>
                    {componentOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <input type="number" min={0} onWheel={e => e.currentTarget.blur()} value={row.amount} onChange={e => updateRow(row.uid, 'amount', e.target.value)} placeholder="0" className={fieldCls()} />
                  <input type="text" value={row.note} onChange={e => updateRow(row.uid, 'note', e.target.value)} placeholder="Optional note" className={fieldCls()} />
                  <button type="button" onClick={() => removeRow(row.uid)} className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-status-error/10 text-text-muted hover:text-status-error transition-colors">
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {salaryRows.length > 0 && (
            <div className="flex items-center justify-between px-4 py-3 rounded-lg bg-linear-to-r from-brand-primary/5 to-brand-primary/10 border border-brand-primary/20">
              <div className="flex items-center gap-2 text-sm font-semibold text-text-body">
                <TrendingUp size={15} className="text-brand-primary" />
                {t('totalGross')}
              </div>
              <span className="text-base font-bold text-brand-primary-dark">
                {formatCurrency(previewGross)}{isDaily ? tp('perDay') : ''}
              </span>
            </div>
          )}
          {isDaily && (
            <p className="text-xs text-text-muted">
              {t('statutoryEstimateFromDaily', {
                rate: formatCurrency(previewGross),
                days: estWorkDaysPerMonth,
              })}
            </p>
          )}
          {isDaily && !payrollConfig.dailyWageStatutoryDeductions && (
            <p className="text-xs text-status-warning font-medium">
              {t('statutoryWaivedForDailyWage')}
            </p>
          )}
        </motion.div>

        {/* ── Deduction Settings ───────────────────────────── */}
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.28, delay: 0.08, ease: 'easeOut' }}
          className="rounded-xl border border-surface-border overflow-hidden"
        >
          <div className="px-4 py-3 bg-surface-page border-b border-surface-border flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Shield size={15} className="text-text-muted" />
              <span className="text-sm font-semibold text-text-heading">{t('deductionSettings')}</span>
              <span className="text-xs text-text-muted font-normal">{t('overrideGlobalDefaults')}</span>
            </div>
            {hasOverride && (
              <button
                type="button"
                onClick={() => { setEmpPfEnabled(null); setEmpEsiEnabled(null); setEmpPtEnabled(null); }}
                className="text-xs text-brand-primary hover:underline font-medium"
              >
                {t('resetToGlobal')}
              </button>
            )}
          </div>

          <div className="divide-y divide-surface-border">
            {/* EPF */}
            {(() => {
              const isOn = empPfEnabled !== null ? empPfEnabled : payrollConfig.pfEnabled;
              return (
                <div className="flex items-center justify-between px-4 py-3.5">
                  <div className="flex-1 min-w-0 me-4">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-text-body">{payrollConfig.pfLabel}</span>
                      {empPfEnabled !== null && (
                        <span className="text-[10px] font-semibold uppercase tracking-wide bg-brand-accent/15 text-brand-accent-dark px-1.5 py-0.5 rounded">{t('overridden')}</span>
                      )}
                    </div>
                    <p className="text-xs text-text-muted mt-0.5">
                      {payrollConfig.pfEnabled ? `Global: ON · ${Math.round(payrollConfig.pfEmployeeRate * 100)}% on basic` : 'Global: OFF'}
                      {isOn && preview.pf > 0 ? ` · Est. deduction: ${formatCurrency(preview.pf)}${isDaily ? ' ' + tp('perMonthEstimated') : '/mo'}` : ''}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setEmpPfEnabled(p => p === null ? !payrollConfig.pfEnabled : !p)}
                    className={`relative w-11 h-6 rounded-full transition-colors duration-200 shrink-0 ${isOn ? 'bg-brand-primary' : 'bg-surface-border'}`}
                  >
                    <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-all duration-200 ${isOn ? 'left-6' : 'left-1'}`} />
                  </button>
                </div>
              );
            })()}

            {/* ESI */}
            {(() => {
              const isOn = empEsiEnabled !== null ? empEsiEnabled : payrollConfig.esiEnabled;
              return (
                <div className="flex items-center justify-between px-4 py-3.5">
                  <div className="flex-1 min-w-0 me-4">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-text-body">{payrollConfig.esiLabel}</span>
                      {empEsiEnabled !== null && (
                        <span className="text-[10px] font-semibold uppercase tracking-wide bg-brand-accent/15 text-brand-accent-dark px-1.5 py-0.5 rounded">{t('overridden')}</span>
                      )}
                    </div>
                    <p className="text-xs text-text-muted mt-0.5">
                      {payrollConfig.esiEnabled
                        ? `Global: ON · ${(payrollConfig.esiEmployeeRate * 100).toFixed(2)}% if gross ≤ ${getCurrencySymbol()}${payrollConfig.esiSalaryCap.toLocaleString()}`
                        : 'Global: OFF'}
                      {isOn && preview.esi > 0 ? ` · Est. deduction: ${formatCurrency(preview.esi)}${isDaily ? ' ' + tp('perMonthEstimated') : '/mo'}` : ''}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setEmpEsiEnabled(p => p === null ? !payrollConfig.esiEnabled : !p)}
                    className={`relative w-11 h-6 rounded-full transition-colors duration-200 shrink-0 ${isOn ? 'bg-status-success' : 'bg-surface-border'}`}
                  >
                    <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-all duration-200 ${isOn ? 'left-6' : 'left-1'}`} />
                  </button>
                </div>
              );
            })()}

            {/* Professional Tax */}
            {(() => {
              const isOn = empPtEnabled !== null ? empPtEnabled : payrollConfig.professionalTaxEnabled;
              return (
                <div className="flex items-center justify-between px-4 py-3.5">
                  <div className="flex-1 min-w-0 me-4">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-text-body">{t('professionalTax')}</span>
                      {empPtEnabled !== null && (
                        <span className="text-[10px] font-semibold uppercase tracking-wide bg-brand-accent/15 text-brand-accent-dark px-1.5 py-0.5 rounded">{t('overridden')}</span>
                      )}
                    </div>
                    <p className="text-xs text-text-muted mt-0.5">
                      {payrollConfig.professionalTaxEnabled ? 'Global: ON · monthly slab-based' : 'Global: OFF'}
                      {isOn && preview.pt > 0 ? ` · Est. deduction: ${formatCurrency(preview.pt)}${isDaily ? ' ' + tp('perMonthEstimated') : '/mo'}` : ''}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setEmpPtEnabled(p => p === null ? !payrollConfig.professionalTaxEnabled : !p)}
                    className={`relative w-11 h-6 rounded-full transition-colors duration-200 shrink-0 ${isOn ? 'bg-brand-accent' : 'bg-surface-border'}`}
                  >
                    <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-all duration-200 ${isOn ? 'left-6' : 'left-1'}`} />
                  </button>
                </div>
              );
            })()}
          </div>
        </motion.div>

        {/* ── Live Summary + Full Preview CTA ─────────────── */}
        <AnimatePresence>
          {grossSalary > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.28, delay: 0.16, ease: 'easeOut' }}
              className="space-y-3"
            >
              {/* Summary bar */}
              <div className="grid grid-cols-3 gap-3">
                <div className="text-center p-3 rounded-lg bg-surface-page border border-surface-border">
                  <p className="text-xs text-text-muted mb-1">{t('grossCtc')}</p>
                  <p className="text-sm font-bold text-text-heading">{formatCurrency(grossSalary)}</p>
                </div>
                <div className="text-center p-3 rounded-lg bg-status-error/5 border border-status-error/15">
                  <p className="text-xs text-text-muted mb-1">{t('totalDeductions')}</p>
                  <p className="text-sm font-bold text-status-error">-{formatCurrency(preview.totalDeductions)}</p>
                </div>
                <div className="text-center p-3 rounded-lg bg-status-success/8 border border-status-success/20">
                  <p className="text-xs text-text-muted mb-1">{t('estTakeHome')}</p>
                  <p className="text-sm font-bold text-status-success">{formatCurrency(preview.netSalary)}</p>
                </div>
              </div>
              {/* Deduction line */}
              <div className="flex flex-wrap gap-x-5 gap-y-1 px-1">
                {effectiveCfg.pfEnabled && <p className="text-xs text-text-muted">EPF: -{formatCurrency(preview.pf)}</p>}
                {effectiveCfg.esiEnabled && <p className="text-xs text-text-muted">ESI: -{formatCurrency(preview.esi)}</p>}
                {effectiveCfg.professionalTaxEnabled && <p className="text-xs text-text-muted">PT: -{formatCurrency(preview.pt)}</p>}
                {payrollConfig.taxEnabled && <p className="text-xs text-text-muted">TDS: -{formatCurrency(preview.tax)}</p>}
              </div>
              {/* Full Preview button */}
              <button
                type="button"
                onClick={() => setShowPayrollPreview(true)}
                className="w-full py-3 bg-brand-primary text-text-on-brand rounded-[--radius-button]
                  hover:bg-brand-primary-dark hover:shadow-md transition-all flex items-center justify-center gap-2
                  font-semibold text-sm"
              >
                <TrendingDown size={16} />
                {t('previewPayrollButton')}
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  };

  const renderStep5 = () => {
    const v = getValues();
    const dept = departments.find(d => d.id === v.departmentId);

    const contractTypeLabel: Record<string, string> = {
      PROBATION: t('contractProbation'), FIXED_TERM: t('contractFixedTerm'), INDEFINITE: t('contractIndefinite'),
    };
    const workTypeLabel: Record<string, string> = { FULL_TIME: t('workModeFullTime'), PART_TIME: t('workModePartTime') };
    const genderLabel: Record<string, string> = { MALE: tc('male'), FEMALE: tc('female'), OTHER: tc('other') };

    return (
      <div className="space-y-5">
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.28, delay: 0, ease: 'easeOut' }}
          className="flex items-center gap-3 p-4 rounded-xl bg-status-success/8 border border-status-success/25"
        >
          <div className="w-10 h-10 rounded-full bg-status-success/15 flex items-center justify-center shrink-0">
            <Check size={20} className="text-status-success" />
          </div>
          <div>
            <p className="text-sm font-semibold text-text-heading">{t('reviewHeading')}</p>
            <p className="text-xs text-text-muted mt-0.5">{t('reviewSubtitle')}</p>
          </div>
        </motion.div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {[
            <ReviewSection key="personal" title={t('sectionPersonalInfo')} icon={User}>
              <InfoRow icon={Hash} label={t('rowEmployeeId')} value={v.employeeCode || t('autoGenerated')} />
              <InfoRow icon={User} label={t('rowFullName')} value={v.fullName} />
              <InfoRow icon={Mail} label={t('rowEmail')} value={v.email} />
              <InfoRow icon={Phone} label={t('rowPhone')} value={v.phone} />
              <InfoRow icon={Calendar} label={t('rowDob')} value={v.dateOfBirth} />
              <InfoRow icon={BadgeCheck} label={t('rowGender')} value={v.gender ? genderLabel[v.gender] : undefined} />
              <InfoRow icon={CreditCard} label={t('rowIdCard')} value={v.idCard} />
              <InfoRow icon={MapPin} label={t('rowAddress')} value={v.address} />
            </ReviewSection>,
            <ReviewSection key="employment" title={t('sectionEmploymentDetails')} icon={Briefcase}>
              <InfoRow icon={Building2} label={t('rowDepartment')} value={dept?.name} />
              <InfoRow icon={Briefcase} label={t('rowPosition')} value={v.position} />
              <InfoRow icon={Calendar} label={t('rowStartDate')} value={v.startDate} />
              {/* Employment type and pay basis were absent from the review entirely,
                  so nobody could see that "50000" was about to mean per DAY. */}
              <InfoRow icon={BadgeCheck} label={t('rowEmploymentType')} value={v.employmentType || undefined} />
              <InfoRow icon={Clock} label={t('rowPayBasis')} value={payBasisLabel(toSalaryBasis(salaryType), tp)} />
              <InfoRow
                icon={CurrencyIcon}
                label={isDaily ? t('dailyRateLabel') : t('rowBaseSalary')}
                value={
                  baseSalary && Number(baseSalary) > 0
                    ? `${formatCurrency(Number(baseSalary))}${isDaily ? tp('perDay') : ''}`
                    : undefined
                }
              />
              <InfoRow icon={Globe} label={t('rowTimezone')} value={v.timezone || t('companyDefault')} />
            </ReviewSection>,
            <ReviewSection key="contract" title={t('sectionContract')} icon={FileText}>
              {v.initialContract?.enabled ? (
                <>
                  <InfoRow icon={FileText} label={t('rowContractType')} value={v.initialContract.contractType ? contractTypeLabel[v.initialContract.contractType] : undefined} />
                  <InfoRow icon={Clock} label={t('rowWorkMode')} value={v.initialContract.workType ? workTypeLabel[v.initialContract.workType] : undefined} />
                  {v.initialContract.workType === 'PART_TIME' && (
                    <InfoRow icon={Clock} label={t('rowHoursPerWeek')} value={v.initialContract.workHoursPerWeek} />
                  )}
                  <InfoRow icon={Calendar} label={t('rowStartDate')} value={v.initialContract.startDate} />
                  {v.initialContract.contractType !== 'INDEFINITE' && (
                    <InfoRow icon={Calendar} label={t('rowEndDate')} value={v.initialContract.endDate || undefined} />
                  )}
                </>
              ) : (
                <div className="py-4 text-center text-sm text-text-muted">{t('noContractYet')}</div>
              )}
            </ReviewSection>,
            <ReviewSection key="payroll" title={t('sectionSalaryComponents')} icon={CurrencyIcon}>
              {baseAmount === 0 && salaryRows.length === 0 ? (
                <div className="py-4 text-center text-sm text-text-muted">{t('noComponentsYet')}</div>
              ) : (
                <>
                  {baseAmount > 0 && (
                    <div className="flex items-center justify-between py-2.5 border-b border-surface-border last:border-0">
                      <p className="text-sm font-medium text-text-body">{t('baseSalaryFromEmployment')}</p>
                      <span className="text-sm font-semibold text-brand-primary">{formatCurrency(baseAmount)}</span>
                    </div>
                  )}
                  {salaryRows.map(row => (
                    <div key={row.uid} className="flex items-center justify-between py-2.5 border-b border-surface-border last:border-0">
                      <div>
                        <p className="text-sm font-medium text-text-body">{componentLabel(row.componentType, componentOptions)}</p>
                        {row.note && <p className="text-xs text-text-muted mt-0.5">{row.note}</p>}
                      </div>
                      <span className="text-sm font-semibold text-brand-primary">
                        {row.amount ? formatCurrency(parseFloat(row.amount)) : '—'}
                      </span>
                    </div>
                  ))}
                  <div className="flex items-center justify-between py-3">
                    <span className="text-sm font-bold text-text-heading">{t('total')}</span>
                    <span className="text-sm font-bold text-brand-primary">{formatCurrency(previewGross)}</span>
                  </div>
                </>
              )}
            </ReviewSection>,
            <ReviewSection key="deductions" title={t('sectionDeductionSettings')} icon={Shield}>
              {(() => {
                const rows = [
                  {
                    label: payrollConfig.pfLabel,
                    enabled: effectiveCfg.pfEnabled,
                    overridden: empPfEnabled !== null,
                    amount: effectiveCfg.pfEnabled ? payrollPreview.pf : 0,
                    detail: payrollConfig.pfEnabled
                      ? `${Math.round(payrollConfig.pfEmployeeRate * 100)}% on basic`
                      : 'Global: OFF',
                  },
                  {
                    label: payrollConfig.esiLabel,
                    enabled: effectiveCfg.esiEnabled,
                    overridden: empEsiEnabled !== null,
                    amount: effectiveCfg.esiEnabled ? payrollPreview.esi : 0,
                    detail: payrollConfig.esiEnabled
                      ? `${(payrollConfig.esiEmployeeRate * 100).toFixed(2)}% if ≤ ${getCurrencySymbol()}${payrollConfig.esiSalaryCap.toLocaleString()}`
                      : 'Global: OFF',
                  },
                  {
                    label: t('professionalTax'),
                    enabled: effectiveCfg.professionalTaxEnabled,
                    overridden: empPtEnabled !== null,
                    amount: effectiveCfg.professionalTaxEnabled ? payrollPreview.pt : 0,
                    detail: payrollConfig.professionalTaxEnabled ? t('monthlySlabBased') : 'Global: OFF',
                  },
                ];
                if (payrollConfig.taxEnabled) {
                  rows.push({
                    label: payrollConfig.taxLabel,
                    enabled: payrollConfig.taxEnabled,
                    overridden: false,
                    amount: payrollPreview.tax,
                    detail: payrollConfig.taxRegime === 'new' ? 'New Tax Regime' : 'Old Tax Regime',
                  });
                }
                return (
                  <>
                    {rows.map(r => (
                      <div key={r.label} className="flex items-center justify-between py-2.5 border-b border-surface-border last:border-0">
                        <div className="flex-1 min-w-0 me-3">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <p className="text-sm font-medium text-text-body">{r.label}</p>
                            {r.overridden && (
                              <span className="text-[10px] font-bold uppercase tracking-wide bg-brand-accent/15 text-brand-accent-dark px-1.5 py-0.5 rounded">
                                {t('overridden')}
                              </span>
                            )}
                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${r.enabled ? 'bg-status-success/12 text-status-success' : 'bg-surface-border text-text-muted'}`}>
                              {r.enabled ? 'ON' : 'OFF'}
                            </span>
                          </div>
                          <p className="text-xs text-text-muted mt-0.5">{r.detail}</p>
                        </div>
                        <span className={`text-sm font-semibold shrink-0 ${r.enabled && r.amount > 0 ? 'text-status-error' : 'text-text-muted'}`}>
                          {r.enabled && r.amount > 0 ? `-${formatCurrency(r.amount)}` : '—'}
                        </span>
                      </div>
                    ))}
                    <div className="flex items-center justify-between py-3 border-b border-surface-border">
                      <span className="text-sm font-bold text-text-heading">{t('totalDeductions')}</span>
                      <span className="text-sm font-bold text-status-error">-{formatCurrency(payrollPreview.totalDeductions)}</span>
                    </div>
                    <div className="flex items-center justify-between py-3">
                      <span className="text-sm font-bold text-text-heading">{t('estTakeHome')}</span>
                      <span className="text-base font-bold text-status-success">{formatCurrency(payrollPreview.netSalary)}</span>
                    </div>
                  </>
                );
              })()}
            </ReviewSection>,
          ].map((card, i) => (
            <motion.div
              key={card.key}
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: 0.06 + i * 0.07, ease: 'easeOut' }}
            >
              {card}
            </motion.div>
          ))}
        </div>
      </div>
    );
  };

  const stepContent = [renderStep1, renderStep2, renderStep3, renderStep4, renderStep5];
  const currentStepMeta = STEPS[step - 1];
  const StepIcon = currentStepMeta.icon;

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <ConfirmDialog />
      <div className="space-y-6">
        {/* The heading itself is declared to TopHeader above; only the back
            affordance belongs on the page. */}
        <PageActionRow
          onBack={() => router.back()}
        />

        {/* Body — sidebar + content */}
        <div className="flex gap-6 items-start">
          {/* ── Left Sidebar Stepper ─────────────────────────────────────── */}
          <aside className="w-56 shrink-0">
            <div className="bg-surface-card rounded-[--radius-card] border border-surface-border p-5 sticky top-6">
              <p className="text-[10px] font-bold uppercase tracking-widest text-text-muted mb-5">{t('onboardingEyebrow')}</p>

              <div className="space-y-0.5">
                {STEPS.map(s => {
                  const Icon = s.icon;
                  const isCompleted = done.has(s.id);
                  const isActive = step === s.id;
                  const isLocked = !isCompleted && !isActive;

                  return (
                    <motion.button
                      key={s.id}
                      type="button"
                      onClick={() => { if (!isLocked) { setDirection(s.id > step ? 1 : -1); setStep(s.id); } }}
                      disabled={isLocked}
                      layout
                      // Colours are classes with a CSS transition, not `animate`
                      // values: framer cannot interpolate `var(--…)` or
                      // `transparent`, so it warned and snapped to the end colour
                      // instead of fading. Opacity still animates here.
                      animate={{ opacity: isLocked ? 0.4 : 1 }}
                      transition={{ duration: 0.2 }}
                      className={`w-full text-start flex items-center gap-3 px-3 py-2.5 rounded-[--radius-button] transition-colors duration-200
                        ${isActive ? 'bg-brand-primary text-white' : isCompleted ? 'hover:bg-surface-border-light text-text-body cursor-pointer' : 'text-text-muted cursor-not-allowed'}`}
                    >
                      <motion.span
                        animate={{ scale: isCompleted && !isActive ? [1, 1.25, 1] : 1 }}
                        transition={{ duration: 0.3 }}
                        className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 text-[11px] font-bold transition-colors duration-300
                          ${isActive ? 'bg-white/20' : isCompleted ? 'bg-status-success' : 'bg-surface-border-light'}`}
                      >
                        <AnimatePresence mode="wait">
                          {isCompleted ? (
                            <motion.span key="check" initial={{ scale: 0, rotate: -90 }} animate={{ scale: 1, rotate: 0 }} exit={{ scale: 0 }} transition={{ duration: 0.2 }}>
                              <Check size={12} className={isActive ? 'text-white' : 'text-white'} />
                            </motion.span>
                          ) : (
                            <motion.span key="icon" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={{ duration: 0.15 }}>
                              <Icon size={12} className={isActive ? 'text-white' : 'text-text-muted'} />
                            </motion.span>
                          )}
                        </AnimatePresence>
                      </motion.span>
                      <div className="min-w-0 flex-1">
                        <p className={`text-xs font-semibold leading-tight truncate ${isActive ? 'text-white' : ''}`}>{s.label}</p>
                      </div>
                      <AnimatePresence>
                        {isActive && (
                          <motion.span initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -4 }} transition={{ duration: 0.15 }}>
                            <ChevronRightIcon size={14} className="text-white/60 shrink-0" />
                          </motion.span>
                        )}
                      </AnimatePresence>
                    </motion.button>
                  );
                })}
              </div>

              {/* Progress bar */}
              <div className="mt-5 pt-5 border-t border-surface-border">
                <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wide text-text-muted mb-2">
                  <span>{t('progress')}</span>
                  <span>{done.size}/{STEPS.length}</span>
                </div>
                <div className="h-1.5 rounded-full bg-surface-border-light overflow-hidden">
                  <div
                    className="h-full rounded-full bg-brand-primary transition-all duration-500"
                    style={{ width: `${(done.size / STEPS.length) * 100}%` }}
                  />
                </div>
                <p className="text-[10px] text-text-muted mt-1.5">
                  {done.size === STEPS.length ? t('allStepsComplete') : t('stepsRemaining', { count: STEPS.length - done.size })}
                </p>
              </div>
            </div>
          </aside>

          {/* ── Main Content ─────────────────────────────────────────────── */}
          <div className="flex-1 min-w-0">
            <div className="bg-surface-card rounded-[--radius-card] border border-surface-border overflow-hidden">
              {/* Step header */}
              <div className="px-7 py-5 border-b border-surface-border bg-gradient-to-r from-brand-primary/3 to-transparent">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-xl bg-brand-primary/10 flex items-center justify-center shrink-0">
                    <StepIcon size={20} className="text-brand-primary" />
                  </div>
                  <div className="flex-1">
                    <h2 className="text-base font-bold text-text-heading">{currentStepMeta.label}</h2>
                    <p className="text-xs text-text-muted mt-0.5">{currentStepMeta.desc}</p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {STEPS.map(s => (
                      <div
                        key={s.id}
                        className={`h-1.5 rounded-full transition-all duration-300 ${
                          done.has(s.id)
                            ? 'bg-status-success w-4'
                            : step === s.id
                            ? 'bg-brand-primary w-6'
                            : 'bg-surface-border w-3'
                        }`}
                      />
                    ))}
                  </div>
                </div>
              </div>

              {/* Step content — animated */}
              <div className="px-7 py-7 overflow-hidden">
                <AnimatePresence mode="wait" custom={direction}>
                  <motion.div
                    key={step}
                    custom={direction}
                    variants={{
                      enter: (d: number) => ({ opacity: 0, x: d * 48, filter: 'blur(2px)' }),
                      center: { opacity: 1, x: 0, filter: 'blur(0px)' },
                      exit: (d: number) => ({ opacity: 0, x: d * -48, filter: 'blur(2px)' }),
                    }}
                    initial="enter"
                    animate="center"
                    exit="exit"
                    transition={{ duration: 0.28, ease: [0.25, 0.46, 0.45, 0.94] }}
                  >
                    {stepContent[step - 1]()}
                  </motion.div>
                </AnimatePresence>
              </div>

              {/* Footer navigation */}
              <div className="px-7 py-4 border-t border-surface-border flex items-center justify-between bg-surface-page/50">
                {/* Back only from Step 2 onward; empty slot keeps Continue right-aligned */}
                {step > 1 ? (
                  <button
                    type="button"
                    onClick={goBack}
                    className="flex items-center gap-2 px-4 py-2 text-sm border border-surface-border text-text-heading
                      rounded-[--radius-button] hover:bg-surface-border-light transition-colors"
                  >
                    <ArrowLeftIcon size={15} /> {t('backBtn')}
                  </button>
                ) : (
                  <span />
                )}

                <div className="flex items-center gap-2">
                  <span className="text-xs text-text-muted">{t('stepOfTotal', { step, total: STEPS.length })}</span>

                  {step < STEPS.length ? (
                    <button
                      type="button"
                      data-testid="onboard-next"
                      onClick={advance}
                      className="flex items-center gap-2 px-5 py-2 text-sm bg-brand-primary text-text-on-brand
                        rounded-[--radius-button] hover:bg-brand-primary-dark transition-all shadow-sm font-medium"
                    >
                      {t('continueBtn')} <ArrowRightIcon size={15} />
                    </button>
                  ) : (
                    <button
                      type="button"
                      data-testid="onboard-submit"
                      onClick={handleSubmit}
                      disabled={submitting}
                      className="flex items-center gap-2 px-5 py-2 text-sm bg-status-success text-white
                        rounded-[--radius-button] hover:bg-green-700 transition-all shadow-sm font-medium disabled:opacity-50"
                    >
                      {submitting ? (
                        <>
                          <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                          {t('creatingBtn')}
                        </>
                      ) : (
                        <><Check size={15} /> {t('createEmployeeBtn')}</>
                      )}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Payroll Preview Modal ──────────────────────────────────────────── */}
      {showPayrollPreview && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-start justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-surface-card rounded-[--radius-card] w-full max-w-2xl my-8 shadow-2xl overflow-hidden">

            {/* Modal Header */}
            <div className="bg-brand-primary px-6 py-5 text-text-on-brand flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2 mb-0.5">
                  <Shield size={18} />
                  <h3 className="text-lg font-bold">{t('previewModalTitle')}</h3>
                </div>
                <p className="text-text-on-brand/75 text-xs">{t('previewModalSubtitle')}</p>
              </div>
              <button
                type="button"
                onClick={() => setShowPayrollPreview(false)}
                className="p-2 hover:bg-white/10 rounded-lg transition-colors"
              >
                <X size={18} />
              </button>
            </div>

            <div className="p-6 space-y-5 max-h-[75vh] overflow-y-auto">

              {/* Earnings + Deductions */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

                {/* Earnings */}
                <div className="bg-status-success/8 border border-status-success/25 rounded-xl p-4">
                  <h4 className="text-sm font-bold text-status-success mb-3 flex items-center gap-1.5">
                    <TrendingUp size={14} /> {t('earningsMonthly')}
                  </h4>
                  <div className="space-y-2.5">
                    {/* Always show base salary */}
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-xs bg-surface-border text-text-muted px-2 py-0.5 rounded font-medium">{t('baseSalaryBadge')}</span>
                      <span className="font-semibold text-text-heading">
                        {baseAmount > 0 ? formatCurrency(baseAmount) : '—'}
                      </span>
                    </div>
                    {/* Additional salary components */}
                    {salaryRows.map(row => (
                      <div key={row.uid} className="flex items-center justify-between text-sm">
                        <div className="flex items-center gap-2 min-w-0 flex-1 me-2">
                          <span className="text-xs bg-brand-primary/10 text-brand-primary px-2 py-0.5 rounded font-medium truncate">
                            {componentLabel(row.componentType, componentOptions)}
                          </span>
                          {row.note && <span className="text-xs text-text-muted truncate">({row.note})</span>}
                        </div>
                        <span className="font-semibold text-text-heading shrink-0">
                          {row.amount ? formatCurrency(parseFloat(row.amount)) : formatCurrency(0)}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 pt-3 border-t border-status-success/20 flex items-center justify-between">
                    <span className="text-sm font-bold text-status-success">{t('grossTotal')}</span>
                    <span className="text-base font-bold text-status-success">{formatCurrency(previewGross)}</span>
                  </div>
                </div>

                {/* Deductions */}
                <div className="bg-status-error/5 border border-status-error/20 rounded-xl p-4">
                  <h4 className="text-sm font-bold text-status-error mb-3 flex items-center gap-1.5">
                    <TrendingDown size={14} /> {t('deductionsMonthly')}
                  </h4>
                  <div className="space-y-3">

                    {/* EPF */}
                    <div className="space-y-0.5">
                      <div className="flex items-center justify-between text-sm">
                        <div className="flex items-center gap-1.5">
                          <span className={`w-2 h-2 rounded-full shrink-0 ${effectiveCfg.pfEnabled ? 'bg-brand-primary' : 'bg-surface-border'}`} />
                          <span className="text-xs font-medium text-text-body">{t('pfLabel')}</span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${effectiveCfg.pfEnabled ? 'bg-brand-primary/10 text-brand-primary' : 'bg-surface-page text-text-muted'}`}>
                            {effectiveCfg.pfEnabled ? 'ON' : 'OFF'}
                          </span>
                          {empPfEnabled !== null && <span className="text-[10px] bg-brand-accent/15 text-brand-accent-dark px-1.5 py-0.5 rounded font-semibold">Override</span>}
                        </div>
                        <span className={`font-semibold text-sm shrink-0 ${effectiveCfg.pfEnabled ? 'text-status-error' : 'text-text-muted'}`}>
                          {effectiveCfg.pfEnabled ? `-${formatCurrency(payrollPreview.pf)}` : '—'}
                        </span>
                      </div>
                      {effectiveCfg.pfEnabled && (
                        <p className="text-xs text-text-muted ps-3.5">{payrollConfig.pfLabel} · {Math.round(payrollConfig.pfEmployeeRate * 100)}%{payrollConfig.pfSalaryCap > 0 ? ` (cap ${getCurrencySymbol()}${payrollConfig.pfSalaryCap.toLocaleString()})` : ''}</p>
                      )}
                    </div>

                    {/* ESI */}
                    <div className="space-y-0.5">
                      <div className="flex items-center justify-between text-sm">
                        <div className="flex items-center gap-1.5">
                          <span className={`w-2 h-2 rounded-full shrink-0 ${effectiveCfg.esiEnabled ? 'bg-status-success' : 'bg-surface-border'}`} />
                          <span className="text-xs font-medium text-text-body">{t('esiLabel')}</span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${effectiveCfg.esiEnabled ? 'bg-status-success/10 text-status-success' : 'bg-surface-page text-text-muted'}`}>
                            {effectiveCfg.esiEnabled ? 'ON' : 'OFF'}
                          </span>
                          {empEsiEnabled !== null && <span className="text-[10px] bg-brand-accent/15 text-brand-accent-dark px-1.5 py-0.5 rounded font-semibold">Override</span>}
                        </div>
                        <span className={`font-semibold text-sm shrink-0 ${effectiveCfg.esiEnabled && payrollPreview.esi > 0 ? 'text-status-error' : 'text-text-muted'}`}>
                          {effectiveCfg.esiEnabled ? (payrollPreview.esi > 0 ? `-${formatCurrency(payrollPreview.esi)}` : `${formatCurrency(0)} (above cap)`) : '—'}
                        </span>
                      </div>
                      {effectiveCfg.esiEnabled && (
                        <p className="text-xs text-text-muted ps-3.5">{payrollConfig.esiLabel} · {(payrollConfig.esiEmployeeRate * 100).toFixed(2)}%{payrollConfig.esiSalaryCap > 0 ? ` (if gross ≤ ${getCurrencySymbol()}${payrollConfig.esiSalaryCap.toLocaleString()})` : ''}</p>
                      )}
                    </div>

                    {/* Professional Tax */}
                    <div className="space-y-0.5">
                      <div className="flex items-center justify-between text-sm">
                        <div className="flex items-center gap-1.5">
                          <span className={`w-2 h-2 rounded-full shrink-0 ${effectiveCfg.professionalTaxEnabled ? 'bg-brand-accent' : 'bg-surface-border'}`} />
                          <span className="text-xs font-medium text-text-body">{t('professionalTax')}</span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${effectiveCfg.professionalTaxEnabled ? 'bg-brand-accent/15 text-brand-accent-dark' : 'bg-surface-page text-text-muted'}`}>
                            {effectiveCfg.professionalTaxEnabled ? 'ON' : 'OFF'}
                          </span>
                          {empPtEnabled !== null && <span className="text-[10px] bg-brand-accent/15 text-brand-accent-dark px-1.5 py-0.5 rounded font-semibold">Override</span>}
                        </div>
                        <span className={`font-semibold text-sm shrink-0 ${effectiveCfg.professionalTaxEnabled && payrollPreview.pt > 0 ? 'text-status-error' : 'text-text-muted'}`}>
                          {effectiveCfg.professionalTaxEnabled ? `-${formatCurrency(payrollPreview.pt)}` : '—'}
                        </span>
                      </div>
                      {effectiveCfg.professionalTaxEnabled && (
                        <p className="text-xs text-text-muted ps-3.5">{t('monthlySlabBasedDesc')}</p>
                      )}
                    </div>

                    {/* Income Tax / TDS */}
                    <div className="space-y-0.5">
                      <div className="flex items-center justify-between text-sm">
                        <div className="flex items-center gap-1.5">
                          <span className={`w-2 h-2 rounded-full shrink-0 ${payrollConfig.taxEnabled ? 'bg-status-info' : 'bg-surface-border'}`} />
                          <span className="text-xs font-medium text-text-body">{payrollConfig.taxLabel}</span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${payrollConfig.taxEnabled ? 'bg-status-info/10 text-status-info' : 'bg-surface-page text-text-muted'}`}>
                            {payrollConfig.taxEnabled ? 'ON' : 'OFF'}
                          </span>
                        </div>
                        <span className={`font-semibold text-sm shrink-0 ${payrollConfig.taxEnabled && payrollPreview.tax > 0 ? 'text-status-error' : 'text-text-muted'}`}>
                          {payrollConfig.taxEnabled ? `-${formatCurrency(payrollPreview.tax)}` : '—'}
                        </span>
                      </div>
                      {payrollConfig.taxEnabled && (
                        <p className="text-xs text-text-muted ps-3.5">
                          {payrollConfig.taxRegime === 'new' ? 'New Tax Regime' : 'Old Tax Regime'}
                          {' · '}Std. deduction {getCurrencySymbol()}{payrollConfig.standardDeduction.toLocaleString()}/yr
                          {payrollConfig.taxRebateEnabled && ` · 87A Rebate ≤ ${getCurrencySymbol()}${payrollConfig.taxRebateLimit.toLocaleString()}/yr`}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="mt-3 pt-3 border-t border-status-error/20 flex items-center justify-between">
                    <span className="text-sm font-bold text-status-error">{t('totalDeductions')}</span>
                    <span className="text-base font-bold text-status-error">-{formatCurrency(payrollPreview.totalDeductions)}</span>
                  </div>
                </div>
              </div>

              {/* Net Salary Highlight */}
              <div className="bg-status-success rounded-xl p-5 text-white">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-white/75 text-xs uppercase tracking-wider mb-1">{t('estimatedTakeHome')}</p>
                    <p className="text-4xl font-bold">{formatCurrency(payrollPreview.netSalary)}</p>
                  </div>
                  <div className="text-end space-y-1">
                    <p className="text-white/75 text-xs">Gross: {formatCurrency(previewGross)}</p>
                    <p className="text-white/75 text-xs">Deductions: -{formatCurrency(payrollPreview.totalDeductions)}</p>
                  </div>
                </div>
              </div>

              <p className="text-center text-xs text-text-muted">
                {t('estimatesNote')}
              </p>
            </div>

            {/* Modal Footer */}
            <div className="flex gap-3 px-6 py-4 border-t border-surface-border bg-surface-page">
              <button
                type="button"
                onClick={() => setShowPayrollPreview(false)}
                className="flex-1 px-4 py-2.5 border border-surface-border bg-surface-card rounded-[--radius-button]
                  hover:bg-surface-page transition-all font-semibold text-text-body text-sm flex items-center justify-center gap-2"
              >
                <ArrowLeftIcon size={15} /> {t('backAndEdit')}
              </button>
              <button
                type="button"
                onClick={() => { setShowPayrollPreview(false); advance(); }}
                className="flex-1 px-4 py-2.5 bg-brand-primary text-text-on-brand rounded-[--radius-button]
                  hover:bg-brand-primary-dark transition-all font-semibold text-sm flex items-center justify-center gap-2"
              >
                <Check size={15} /> {t('confirmAndContinue')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

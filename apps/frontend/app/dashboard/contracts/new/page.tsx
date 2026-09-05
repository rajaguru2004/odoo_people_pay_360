'use client';

import { useState, useEffect, Suspense, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter, useSearchParams } from 'next/navigation';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import {
    FileSignature, ArrowLeft, User, FileText, Search, X,
    Sliders, ChevronDown, ChevronUp, Plus, Trash2, Eye, CheckCircle2,
    Info, TrendingDown, TrendingUp, AlertCircle, Shield,
} from 'lucide-react';
import { CurrencyIcon } from '@/components/common/CurrencyIcon';
import contractService from '@/services/contractService';
import { toComponentCode } from '@/utils/salaryComponentUtils';
import employeeService from '@/services/employeeService';
import salaryComponentService from '@/services/salaryComponentService';
import libraryService from '@/services/libraryService';
import systemSettingsService from '@/services/systemSettingsService';
import { useStartDateBounds } from '@/hooks/useStartDateBounds';
import { Employee } from '@/types/employee';
import { ContractType, WorkType } from '@/types/contract';
import { toast } from '@/lib/toast';
import { getApiErrorMessage } from '@/lib/apiError';
import { formatCurrency, getCurrencySymbol, getCurrencyCode } from '@/utils/formatters';
import { estimatedWorkDaysPerMonth, isDailyWage, monthlyEquivalent, toSalaryBasis } from '@/utils/payBasis';
import PageActionRow from '@/components/common/PageActionRow';
import { usePageHeader } from '@/hooks/usePageHeader';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ComponentType = string;

interface PayrollComponentDraft {
    id: string;
    componentType: ComponentType;
    amount: number;
    note: string;
    effectiveDate: string;
}

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
    /** Configured work week, used to monthly-ise a day rate for this preview. */
    workDaysPerWeek: number;
    /** When false, daily-wage staff take no statutory deductions at all. */
    dailyWageStatutoryDeductions: boolean;
}

interface PayrollPreview {
    grossSalary: number;
    basicSalary: number;
    pf: number;
    esi: number;
    professionalTax: number;
    tax: number;
    totalDeductions: number;
    netSalary: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_PAYROLL_CONFIG: PayrollConfig = {
    workDaysPerWeek: 5,
    dailyWageStatutoryDeductions: true,
    currencySymbol: '₹',
    pfEnabled: true,
    pfEmployeeRate: 0.12,
    pfSalaryCap: 15000,
    pfLabel: 'EPF (Employee Provident Fund)',
    esiEnabled: true,
    esiEmployeeRate: 0.0075,
    esiSalaryCap: 21000,
    esiLabel: 'ESI (Employee State Insurance)',
    professionalTaxEnabled: true,
    professionalTaxSlabs: [
        { upTo: 10000, tax: 0 }, { upTo: 15000, tax: 110 },
        { upTo: 20000, tax: 130 }, { upTo: 25000, tax: 150 },
        { upTo: 999999999, tax: 200 },
    ],
    taxEnabled: true,
    taxRegime: 'new',
    standardDeduction: 75000,
    taxRebateEnabled: true,
    taxRebateLimit: 700000,
    cessEnabled: true,
    cessRate: 0.04,
    taxLabel: 'Income Tax / TDS',
    taxBrackets: [
        { limit: 300000, rate: 0 }, { limit: 700000, rate: 0.05 },
        { limit: 1000000, rate: 0.1 }, { limit: 1200000, rate: 0.15 },
        { limit: 1500000, rate: 0.2 }, { limit: 999999999, rate: 0.3 },
    ],
};

// Contract type / work mode come from user-editable library labels (e.g.
// "Definite term (12-36 months)", "Full-time"), but the backend validates
// against fixed enums. Map the selected label to its enum value before submit
// using the same keyword matching the rest of the form relies on.
const mapContractTypeToEnum = (label: string): ContractType => {
    const l = (label || '').toLowerCase();
    if (l.includes('indefinite')) return 'INDEFINITE';
    if (l.includes('probation')) return 'PROBATION';
    return 'FIXED_TERM'; // "Definite term …" and any other → fixed term
};

const mapWorkTypeToEnum = (label: string): WorkType =>
    (label || '').toLowerCase().includes('part') ? 'PART_TIME' : 'FULL_TIME';

const getColorForType = (type: string) => {
    const colors = [
        'bg-brand-primary-light/20 text-brand-primary',
        'bg-status-success-bg text-status-success',
        'bg-status-info-bg text-status-info',
        'bg-brand-accent/15 text-brand-accent-dark',
        'bg-purple-100 text-purple-700',
        'bg-pink-100 text-pink-700',
        'bg-brand-primary-light/30 text-brand-primary-dark',
        'bg-yellow-100 text-yellow-700',
    ];
    let hash = 0;
    for (let i = 0; i < type.length; i++) {
        hash = type.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
};

// ─── Calculation Helpers ──────────────────────────────────────────────────────

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
 * On a daily-wage employee every component amount is a PER-DAY figure, while
 * PF/ESI caps and PT slabs are monthly thresholds — so the per-period totals are
 * monthly-ised before any cap comparison. The cap/slab math itself is untouched.
 */
function calculatePayrollPreview(
    components: PayrollComponentDraft[],
    cfg: PayrollConfig,
    basis: 'MONTHLY' | 'DAILY' = 'MONTHLY',
    estWorkDaysPerMonth = 22,
): PayrollPreview {
    const perPeriodGross = components.reduce((s, c) => s + c.amount, 0);
    const perPeriodBasic = components.find(c => c.componentType.toLowerCase().includes('basic'))?.amount ?? 0;
    const grossSalary = monthlyEquivalent(basis, perPeriodGross, estWorkDaysPerMonth);
    const basicSalary = monthlyEquivalent(basis, perPeriodBasic, estWorkDaysPerMonth);

    // PF / EPF — applied on Basic salary up to cap
    let pf = 0;
    if (cfg.pfEnabled && basicSalary > 0) {
        const pfBase = cfg.pfSalaryCap > 0 ? Math.min(basicSalary, cfg.pfSalaryCap) : basicSalary;
        pf = pfBase * cfg.pfEmployeeRate;
    }

    // ESI — on gross salary if below the salary cap
    let esi = 0;
    if (cfg.esiEnabled && grossSalary > 0 && (cfg.esiSalaryCap <= 0 || grossSalary <= cfg.esiSalaryCap)) {
        esi = grossSalary * cfg.esiEmployeeRate;
    }

    // Professional Tax — monthly slab lookup
    let professionalTax = 0;
    if (cfg.professionalTaxEnabled && cfg.professionalTaxSlabs?.length > 0) {
        for (const slab of cfg.professionalTaxSlabs) {
            if (grossSalary <= slab.upTo) { professionalTax = slab.tax; break; }
        }
        if (professionalTax === 0 && grossSalary > 0) {
            professionalTax = cfg.professionalTaxSlabs[cfg.professionalTaxSlabs.length - 1]?.tax ?? 0;
        }
    }

    const insurance = pf + esi;

    // Income Tax / TDS — annual projection using configured brackets
    let tax = 0;
    if (cfg.taxEnabled && grossSalary > 0) {
        const annualGross = grossSalary * 12;
        const taxableAnnual = Math.max(0, annualGross - insurance * 12 - cfg.standardDeduction);
        let annualTax = applyBrackets(taxableAnnual, cfg.taxBrackets);
        if (cfg.taxRebateEnabled && taxableAnnual <= cfg.taxRebateLimit) annualTax = 0;
        if (cfg.cessEnabled && annualTax > 0) annualTax *= (1 + cfg.cessRate);
        tax = annualTax / 12;
    }

    const totalDeductions = insurance + professionalTax + tax;
    return {
        grossSalary: Math.round(grossSalary),
        basicSalary: Math.round(basicSalary),
        pf: Math.round(pf),
        esi: Math.round(esi),
        professionalTax: Math.round(professionalTax),
        tax: Math.round(tax),
        totalDeductions: Math.round(totalDeductions),
        netSalary: Math.round(grossSalary - totalDeductions),
    };
}

// ─── Main Form Component ──────────────────────────────────────────────────────

function NewContractForm() {
    const t = useTranslations('newContractPage');
    const router = useRouter();
    const searchParams = useSearchParams();

    // The one heading for this route, rendered by TopHeader. Kept after
    // useSearchParams, which is the hook this component suspends on.
    usePageHeader(t('title'), t('subtitle'));

    const employeeIdParam = searchParams.get('employeeId');
    const dropdownRef = useRef<HTMLDivElement>(null);
    const formRef = useRef<HTMLFormElement>(null);
    // Picker hints only — the server holds the real policy.
    const startDateBounds = useStartDateBounds();

    // ── Existing state ──
    const [loading, setLoading] = useState(false);
    const [employees, setEmployees] = useState<Employee[]>([]);
    const [filteredEmployees, setFilteredEmployees] = useState<Employee[]>([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [showDropdown, setShowDropdown] = useState(false);
    const [selectedEmployee, setSelectedEmployee] = useState<Employee | null>(null);
    const [formData, setFormData] = useState({
        employeeId: employeeIdParam || '',
        contractType: 'PROBATION',
        workType: 'FULL_TIME',
        workHoursPerWeek: 40,
        startDate: '',
        endDate: '',
        salary: '',
        notes: '',
    });

    // ── Payroll state ──
    const [enablePayrollSettings, setEnablePayrollSettings] = useState(false);
    const [useGlobalDefaults, setUseGlobalDefaults] = useState(false);
    const [payrollComponents, setPayrollComponents] = useState<PayrollComponentDraft[]>([]);
    const [payrollConfig, setPayrollConfig] = useState<PayrollConfig>(DEFAULT_PAYROLL_CONFIG);
    const [showPayrollPreview, setShowPayrollPreview] = useState(false);
    const [showConfigInfo, setShowConfigInfo] = useState(false);
    const [savingPayroll, setSavingPayroll] = useState(false);
    // Per-employee deduction overrides (null = follow global setting)
    const [empPfEnabled, setEmpPfEnabled] = useState<boolean | null>(null);
    const [empEsiEnabled, setEmpEsiEnabled] = useState<boolean | null>(null);
    const [empPtEnabled, setEmpPtEnabled] = useState<boolean | null>(null);
    const [componentTypes, setComponentTypes] = useState<string[]>(['Basic salary']);
    const [contractTypes, setContractTypes] = useState<string[]>(['Probation (≤60 days)', 'Definite term (12-36 months)', 'Indefinite']);
    const [workModes, setWorkModes] = useState<string[]>(['Full-time', 'Part-time']);

    // ── Effects ──
    useEffect(() => {
        fetchEmployees();
        fetchPayrollConfig();
        fetchLibraryOptions();
    }, []);

    const fetchLibraryOptions = async () => {
        try {
            const [salaryRes, contractRes, workModeRes] = await Promise.all([
                libraryService.getAll('SALARY_COMPONENT_TYPE', true),
                libraryService.getAll('CONTRACT_TYPE', true),
                libraryService.getAll('WORK_MODE', true),
            ]);
            
            if (salaryRes?.success && salaryRes.data.length > 0) {
                setComponentTypes(salaryRes.data.map((p: any) => p.label));
            }
            if (contractRes?.success && contractRes.data.length > 0) {
                setContractTypes(contractRes.data.map((p: any) => p.label));
                setFormData(f => ({ ...f, contractType: contractRes.data[0].label }));
            }
            if (workModeRes?.success && workModeRes.data.length > 0) {
                setWorkModes(workModeRes.data.map((p: any) => p.label));
                setFormData(f => ({ ...f, workType: workModeRes.data[0].label }));
            }
        } catch (error) {
            console.error('Failed to fetch library options:', error);
        }
    };

    useEffect(() => {
        if (employeeIdParam && employees.length > 0) {
            const emp = employees.find(e => e.id === employeeIdParam);
            if (emp) { setSelectedEmployee(emp); setSearchQuery(`${emp.employeeCode} - ${emp.fullName}`); }
        }
    }, [employeeIdParam, employees.length]);

    useEffect(() => {
        if (searchQuery.trim() === '') { setFilteredEmployees(employees); }
        else {
            const q = searchQuery.toLowerCase();
            setFilteredEmployees(employees.filter(emp =>
                emp.fullName.toLowerCase().includes(q) ||
                emp.employeeCode.toLowerCase().includes(q) ||
                emp.position.toLowerCase().includes(q) ||
                emp.email.toLowerCase().includes(q)
            ));
        }
    }, [searchQuery, employees]);

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) setShowDropdown(false);
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // ── Data fetchers ──
    const fetchEmployees = async () => {
        try {
            const res = await employeeService.getWithoutActiveContract(100);
            if (res.success && res.data) setEmployees(res.data);
        } catch (error: any) {
            toast.error(error?.message || t('loadEmployeesFailed'));
        }
    };

    const fetchPayrollConfig = async () => {
        try {
            const res: any = await systemSettingsService.getAll();
            if (!res?.success) return;
            const find = (key: string) => res.data.find((s: any) => s.key === key)?.value ?? '';
            const tryParseJSON = <T,>(raw: string, fallback: T): T => {
                try { return JSON.parse(raw) as T; } catch { return fallback; }
            };

            const country = find('payroll_country') || 'IN';
            const customPf = find('payroll_label_pf')?.trim();
            const customEsi = find('payroll_label_esi')?.trim();
            const customTax = find('payroll_label_income_tax')?.trim();

            const COUNTRY_LABELS: Record<string, { pf: string; esi: string; tax: string }> = {
                IN: { pf: 'EPF (Employee Provident Fund)', esi: 'ESI (Employee State Insurance)', tax: 'Income Tax / TDS' },
                US: { pf: 'FICA (Social Security + Medicare)', esi: 'Healthcare Benefit', tax: 'Federal Income Tax' },
                GB: { pf: 'National Insurance (NI)', esi: 'NHS Contribution', tax: 'Income Tax (PAYE)' },
                AE: { pf: 'GPSSA', esi: 'Health Insurance', tax: 'Income Tax' },
                SG: { pf: 'CPF (Central Provident Fund)', esi: 'Medisave', tax: 'Income Tax' },
                DE: { pf: 'Sozialversicherung', esi: 'Krankenversicherung', tax: 'Einkommensteuer' },
            };
            const labels = COUNTRY_LABELS[country] ?? COUNTRY_LABELS['IN'];

            setPayrollConfig({
                currencySymbol: find('payroll_currency_symbol') || '₹',
                pfEnabled: find('payroll_pf_enabled') !== 'false',
                pfEmployeeRate: parseFloat(find('payroll_pf_employee_rate') || '0.12'),
                pfSalaryCap: parseFloat(find('payroll_pf_salary_cap') || '15000'),
                pfLabel: customPf || labels.pf,
                esiEnabled: find('payroll_esi_enabled') !== 'false',
                esiEmployeeRate: parseFloat(find('payroll_esi_employee_rate') || '0.0075'),
                esiSalaryCap: parseFloat(find('payroll_esi_salary_cap') || '21000'),
                esiLabel: customEsi || labels.esi,
                professionalTaxEnabled: find('payroll_professional_tax_enabled') !== 'false',
                professionalTaxSlabs: tryParseJSON(find('payroll_professional_tax_slabs'), DEFAULT_PAYROLL_CONFIG.professionalTaxSlabs),
                taxEnabled: true,
                taxRegime: find('payroll_tax_regime') || 'new',
                standardDeduction: parseFloat(find('payroll_standard_deduction') || '75000'),
                taxRebateEnabled: find('payroll_tax_rebate_enabled') !== 'false',
                taxRebateLimit: parseFloat(find('payroll_tax_rebate_limit') || '700000'),
                cessEnabled: find('payroll_cess_enabled') !== 'false',
                cessRate: parseFloat(find('payroll_cess_rate') || '0.04'),
                taxLabel: customTax || labels.tax,
                taxBrackets: tryParseJSON(find('payroll_tax_brackets'), DEFAULT_PAYROLL_CONFIG.taxBrackets),
                workDaysPerWeek: parseFloat(find('payroll_work_days_per_week') || '5'),
                dailyWageStatutoryDeductions:
                    find('payroll_daily_wage_statutory_deductions') !== 'false',
            });
        } catch {
            // fall back to Indian defaults already set in state
        }
    };

    // ── Employee handlers ──
    const handleSelectEmployee = (emp: Employee) => {
        setSelectedEmployee(emp);
        setFormData(f => ({ ...f, employeeId: emp.id }));
        setSearchQuery(`${emp.employeeCode} - ${emp.fullName}`);
        setShowDropdown(false);
    };

    const handleClearEmployee = () => {
        setSelectedEmployee(null);
        setFormData(f => ({ ...f, employeeId: '' }));
        setSearchQuery('');
    };

    // ── Payroll settings handlers ──
    const handleEnablePayrollSettings = (enabled: boolean) => {
        setEnablePayrollSettings(enabled);
        if (!enabled) {
            setUseGlobalDefaults(false);
            setPayrollComponents([]);
            setShowPayrollPreview(false);
            // Reset overrides to null (follow global)
            setEmpPfEnabled(null);
            setEmpEsiEnabled(null);
            setEmpPtEnabled(null);
        }
    };

    const handleUseGlobalDefaults = (checked: boolean) => {
        setUseGlobalDefaults(checked);
        if (checked && formData.salary) {
            const basicAmount = parseFloat(formData.salary) || 0;
            const effectiveDate = formData.startDate || new Date().toISOString().split('T')[0];
            setPayrollComponents(prev => {
                const hasBasic = prev.some(c => c.componentType.toLowerCase().includes('basic'));
                if (hasBasic) {
                    return prev.map(c => c.componentType.toLowerCase().includes('basic') ? { ...c, amount: basicAmount } : c);
                }
                const basicType = componentTypes.find(t => t.toLowerCase().includes('basic')) || componentTypes[0] || 'Basic salary';
                return [
                    { id: `basic-${Date.now()}`, componentType: basicType, amount: basicAmount, note: 'Basic Salary', effectiveDate },
                    ...prev,
                ];
            });
        }
    };

    const addPayrollComponent = () => {
        const effectiveDate = formData.startDate || new Date().toISOString().split('T')[0];
        setPayrollComponents(prev => [
            ...prev,
            { id: `comp-${Date.now()}-${Math.random()}`, componentType: componentTypes[0], amount: 0, note: '', effectiveDate },
        ]);
    };

    const updatePayrollComponent = (id: string, field: keyof PayrollComponentDraft, value: string | number | ComponentType) => {
        setPayrollComponents(prev => prev.map(c => c.id === id ? { ...c, [field]: value } : c));
    };

    const removePayrollComponent = (id: string) => {
        setPayrollComponents(prev => prev.filter(c => c.id !== id));
    };

    // ── Submit handler ──
    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!formData.employeeId || !formData.startDate || !formData.salary) {
            toast.error(t('fillRequiredInfo'));
            return;
        }
        if (enablePayrollSettings && payrollComponents.some(c => c.amount < 0)) {
            toast.error(t('componentAmountsNonNegative'));
            return;
        }

        try {
            setLoading(true);

            // 1. Create the contract — map library labels to the backend enums
            const contractType = mapContractTypeToEnum(formData.contractType);
            const contractRes = await contractService.create({
                employeeId: formData.employeeId,
                contractType,
                workType: mapWorkTypeToEnum(formData.workType),
                workHoursPerWeek: formData.workHoursPerWeek,
                startDate: formData.startDate,
                endDate: contractType === 'INDEFINITE' ? undefined : (formData.endDate || undefined),
                salary: parseFloat(formData.salary),
                notes: formData.notes || undefined,
            });

            if (!contractRes.success) {
                toast.error(t('createFailed'));
                return;
            }

            // 2. Create salary components + PAYROLL_CONFIG override if payroll settings are enabled
            if (enablePayrollSettings) {
                setSavingPayroll(true);
                let failedCount = 0;

                // Save salary components
                for (const comp of payrollComponents) {
                    try {
                        await salaryComponentService.create({
                            employeeId: formData.employeeId,
                            componentType: toComponentCode(String(comp.componentType)),
                            amount: comp.amount,
                            effectiveDate: comp.effectiveDate || formData.startDate,
                            note: comp.note || undefined,
                        });
                    } catch (err: any) {
                        failedCount++;
                        console.error(`Failed to save ${comp.componentType} component:`, err?.response?.data?.message || err);
                    }
                }

                // Save PAYROLL_CONFIG override if any deduction toggle differs from global
                const hasOverride = empPfEnabled !== null || empEsiEnabled !== null || empPtEnabled !== null;
                if (hasOverride) {
                    try {
                        const overrides: Record<string, boolean> = {};
                        if (empPfEnabled !== null) overrides.pfEnabled = empPfEnabled;
                        if (empEsiEnabled !== null) overrides.esiEnabled = empEsiEnabled;
                        if (empPtEnabled !== null) overrides.professionalTaxEnabled = empPtEnabled;
                        await salaryComponentService.create({
                            employeeId: formData.employeeId,
                            componentType: 'PAYROLL_CONFIG' as any,
                            amount: 0,
                            effectiveDate: formData.startDate,
                            note: JSON.stringify(overrides),
                        });
                    } catch (err: any) {
                        failedCount++;
                        console.error('Failed to save payroll config overrides:', err?.response?.data?.message || err);
                    }
                }

                if (failedCount > 0) {
                    toast.warning(t('contractCreatedPayrollFailed', { count: failedCount }));
                } else {
                    toast.success(t('createSuccessWithPayroll'));
                }
            } else {
                toast.success(t('createSuccess'));
            }

            router.push(`/dashboard/contracts/${contractRes.data.id}`);
        } catch (error: any) {
            console.error('Failed to create contract:', error);
            // Surface the actual backend reason (validation/business-rule message),
            // falling back to a generic message only when none is present.
            toast.error(getApiErrorMessage(error, t('createFailedFallback')));
        } finally {
            setLoading(false);
            setSavingPayroll(false);
        }
    };

    // ── Derived values ──
    // Effective config = global merged with per-employee overrides
    const effectiveConfig: PayrollConfig = {
        ...payrollConfig,
        pfEnabled: empPfEnabled !== null ? empPfEnabled : payrollConfig.pfEnabled,
        esiEnabled: empEsiEnabled !== null ? empEsiEnabled : payrollConfig.esiEnabled,
        professionalTaxEnabled: empPtEnabled !== null ? empPtEnabled : payrollConfig.professionalTaxEnabled,
    };
    // Contracts have no pay basis of their own, so it comes from the employee.
    const employeeBasis = toSalaryBasis(selectedEmployee?.salaryType);
    const employeeIsDaily = isDailyWage(employeeBasis);
    const estWorkDaysPerMonth = estimatedWorkDaysPerMonth(payrollConfig.workDaysPerWeek);
    const statutoryApplies = !employeeIsDaily || payrollConfig.dailyWageStatutoryDeductions;
    const preview = statutoryApplies
        ? calculatePayrollPreview(payrollComponents, effectiveConfig, employeeBasis, estWorkDaysPerMonth)
        : calculatePayrollPreview([], effectiveConfig);
    const totalGross = payrollComponents.reduce((s, c) => s + c.amount, 0);

    // ─────────────────────────────────────────────────────────────────────────
    return (
        <ProtectedRoute requiredPermission="MANAGE_CONTRACTS">
            <>
                <div className="max-w-4xl mx-auto space-y-6">
                    {/* Heading lives in TopHeader via usePageHeader — the back navigation stays here. */}
                    <PageActionRow onBack={() => router.back()} />

                    {/* Form */}
                    <form ref={formRef} onSubmit={handleSubmit} className="space-y-5">

                        {/* ── Employee Selection ── */}
                        <div className="bg-surface-card rounded-[--radius-card] border border-surface-border p-5 shadow-sm">
                            <div className="flex items-center gap-2 mb-4">
                                <User size={18} className="text-brand-primary" />
                                <h2 className="text-base font-bold text-text-heading">{t('selectEmployeeHeading')}</h2>
                                <span className="text-status-error">*</span>
                            </div>
                            <div className="relative" ref={dropdownRef}>
                                <div className="relative">
                                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" size={18} />
                                    <input
                                        data-testid="con-form-employee-search"
                                        type="text" value={searchQuery}
                                        onChange={(e) => { setSearchQuery(e.target.value); setShowDropdown(true); }}
                                        onFocus={() => setShowDropdown(true)}
                                        placeholder={t('searchingEmployees')}
                                        className="w-full pl-10 pr-10 py-2.5 border border-surface-border rounded-[--radius-input] focus:ring-2 focus:ring-brand-primary/15 focus:border-brand-primary transition-all text-sm bg-surface-card text-text-body"
                                        required
                                    />
                                    {selectedEmployee && (
                                        <button type="button" onClick={handleClearEmployee} className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-status-error">
                                            <X size={18} />
                                        </button>
                                    )}
                                </div>
                                {showDropdown && filteredEmployees.length > 0 && (
                                    <div className="absolute z-50 w-full mt-1 bg-surface-card border border-surface-border rounded-[--radius-input] shadow-xl max-h-60 overflow-y-auto">
                                        {filteredEmployees.slice(0, 50).map((emp) => (
                                            <button key={emp.id} data-testid={`con-form-employee-option-${emp.employeeCode}`} type="button" onClick={() => handleSelectEmployee(emp)}
                                                className={`w-full px-3 py-2.5 text-left hover:bg-brand-primary-light/5 transition-colors border-b border-surface-border-light last:border-b-0 ${selectedEmployee?.id === emp.id ? 'bg-brand-primary-light/10' : ''}`}>
                                                <div className="flex items-center gap-2">
                                                    <div className="w-8 h-8 rounded-full bg-brand-primary flex items-center justify-center text-text-on-brand font-bold text-xs">
                                                        {emp.fullName.charAt(0)}
                                                    </div>
                                                    <div className="flex-1 min-w-0">
                                                        <div className="font-semibold text-text-heading text-sm truncate">{emp.fullName}</div>
                                                        <div className="text-xs text-text-muted truncate">{emp.employeeCode} • {emp.position}</div>
                                                    </div>
                                                </div>
                                            </button>
                                        ))}
                                    </div>
                                )}
                                {showDropdown && searchQuery && filteredEmployees.length === 0 && (
                                    <div className="absolute z-50 w-full mt-1 bg-surface-card border border-surface-border rounded-[--radius-input] shadow-xl p-3 text-center text-text-muted text-sm">
                                        {t('noStaffFound')}
                                    </div>
                                )}
                                {selectedEmployee && (
                                    <div className="mt-3 p-3 bg-brand-primary-light/10 border border-brand-primary/20 rounded-[--radius-input]">
                                        <div className="flex items-center gap-2">
                                            <div className="w-10 h-10 rounded-full bg-brand-primary flex items-center justify-center text-text-on-brand font-bold">
                                                {selectedEmployee.fullName.charAt(0)}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className="font-bold text-text-heading text-sm">{selectedEmployee.fullName}</div>
                                                <div className="text-xs text-text-muted">{selectedEmployee.employeeCode} • {selectedEmployee.position}</div>
                                            </div>
                                        </div>
                                    </div>
                                )}
                                {employees.length > 0 && (
                                    <p className="text-xs text-text-muted mt-2">
                                        {t('showEmployeesNoContract', { count: employees.length })}
                                    </p>
                                )}
                            </div>
                        </div>

                        {/* ── Contract Information ── */}
                        <div className="bg-surface-card rounded-[--radius-card] border border-surface-border p-5 shadow-sm">
                            <div className="flex items-center gap-2 mb-4">
                                <FileText size={18} className="text-brand-accent" />
                                <h2 className="text-base font-bold text-text-heading">{t('contractInfoHeading')}</h2>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-semibold text-text-body mb-1.5">
                                        {t('contractTypeLabel')} <span className="text-status-error">*</span>
                                    </label>
                                    <select data-testid="con-form-type" value={formData.contractType}
                                        onChange={(e) => setFormData({ ...formData, contractType: e.target.value })}
                                        className="w-full px-3 py-2.5 border border-surface-border bg-surface-card text-text-body rounded-[--radius-input] focus:ring-2 focus:ring-brand-primary/15 focus:border-brand-primary transition-all text-sm" required>
                                        {contractTypes.map(opt => (
                                            <option key={opt} value={opt}>{opt}</option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-sm font-semibold text-text-body mb-1.5">
                                        {t('workModeLabel')} <span className="text-status-error">*</span>
                                    </label>
                                    <select data-testid="con-form-worktype" value={formData.workType}
                                        onChange={(e) => {
                                            const workType = e.target.value;
                                            setFormData({ ...formData, workType, workHoursPerWeek: workType.toLowerCase().includes('part') ? 20 : 40 });
                                        }}
                                        className="w-full px-3 py-2.5 border border-surface-border bg-surface-card text-text-body rounded-[--radius-input] focus:ring-2 focus:ring-brand-primary/15 focus:border-brand-primary transition-all text-sm" required>
                                        {workModes.map(opt => (
                                            <option key={opt} value={opt}>{opt}</option>
                                        ))}
                                    </select>
                                </div>
                                {formData.workType?.toLowerCase().includes('part') && (
                                    <div className="md:col-span-2">
                                        <label className="block text-sm font-semibold text-text-body mb-1.5">
                                            {t('hoursPerWeekLabel')} <span className="text-status-error">*</span>
                                        </label>
                                        <input data-testid="con-form-hours" type="number" value={formData.workHoursPerWeek}
                                            onChange={(e) => setFormData({ ...formData, workHoursPerWeek: parseInt(e.target.value) || 0 })}
                                            onWheel={(e) => e.currentTarget.blur()}
                                            className="w-full px-3 py-2.5 border border-surface-border bg-surface-card text-text-body rounded-[--radius-input] focus:ring-2 focus:ring-brand-primary/15 focus:border-brand-primary transition-all text-sm"
                                            min="1" max="39" placeholder="20" required />
                                    </div>
                                )}
                                <div>
                                    <label className="block text-sm font-semibold text-text-body mb-1.5">
                                        {t('startDateLabel')} <span className="text-status-error">*</span>
                                    </label>
                                    <input data-testid="con-form-start" type="date" value={formData.startDate}
                                        onChange={(e) => setFormData({ ...formData, startDate: e.target.value })}
                                        min={startDateBounds.min}
                                        max={startDateBounds.max}
                                        className="w-full px-3 py-2.5 border border-surface-border bg-surface-card text-text-body rounded-[--radius-input] focus:ring-2 focus:ring-brand-primary/15 focus:border-brand-primary transition-all text-sm" required />
                                    <p className="mt-1 text-xs text-text-muted">{t('startDateHint')}</p>
                                    {formData.startDate && (
                                        <p className="mt-1 text-xs text-text-muted">
                                            {t('componentsEffectiveFrom', { date: formData.startDate })}
                                        </p>
                                    )}
                                </div>
                                <div>
                                    <label className="block text-sm font-semibold text-text-body mb-1.5">
                                        {t('endDateLabel')} {!formData.contractType?.toLowerCase().includes('indefinite') && <span className="text-status-error">*</span>}
                                    </label>
                                    <input data-testid="con-form-end" type="date" value={formData.endDate}
                                        onChange={(e) => setFormData({ ...formData, endDate: e.target.value })}
                                        className="w-full px-3 py-2.5 border border-surface-border bg-surface-card text-text-body rounded-[--radius-input] focus:ring-2 focus:ring-brand-primary/15 focus:border-brand-primary transition-all text-sm disabled:bg-surface-page disabled:cursor-not-allowed"
                                        required={!formData.contractType?.toLowerCase().includes('indefinite')}
                                        disabled={formData.contractType?.toLowerCase().includes('indefinite')} />
                                </div>
                                <div className="md:col-span-2">
                                    <label className="block text-sm font-semibold text-text-body mb-1.5">
                                        {t('baseSalaryLabel')} ({getCurrencyCode()}) <span className="text-status-error">*</span>
                                    </label>
                                    <div className="relative">
                                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted text-sm pointer-events-none">{getCurrencySymbol()}</span>
                                        <input data-testid="con-form-salary" type="number" value={formData.salary}
                                            onChange={(e) => setFormData({ ...formData, salary: e.target.value })}
                                            onWheel={(e) => e.currentTarget.blur()}
                                            className="w-full pl-10 pr-3 py-2.5 border border-surface-border bg-surface-card text-text-body rounded-[--radius-input] focus:ring-2 focus:ring-brand-primary/15 focus:border-brand-primary transition-all text-sm"
                                            placeholder="10,000,000" min="0" step="1" required />
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* ══ Payroll Settings Section ══════════════════════════════════════ */}
                        <div className={`bg-surface-card rounded-[--radius-card] border shadow-sm transition-all duration-200 ${enablePayrollSettings ? 'border-brand-primary/40' : 'border-surface-border'}`}>

                            {/* Section Toggle Header */}
                            <div
                                className={`p-5 flex items-center justify-between cursor-pointer rounded-[--radius-card] transition-colors ${enablePayrollSettings ? 'bg-gradient-to-r from-brand-primary-light/10 to-brand-primary-light/20 rounded-b-none' : 'hover:bg-surface-page'}`}
                                onClick={() => handleEnablePayrollSettings(!enablePayrollSettings)}
                            >
                                <div className="flex items-center gap-3">
                                    <div className={`w-9 h-9 rounded-[--radius-button] flex items-center justify-center transition-colors ${enablePayrollSettings ? 'bg-brand-primary' : 'bg-surface-page'}`}>
                                        <Sliders size={17} className={enablePayrollSettings ? 'text-text-on-brand' : 'text-text-muted'} />
                                    </div>
                                    <div>
                                        <div className="flex items-center gap-2">
                                            <h2 className="text-base font-bold text-text-heading">{t('payrollSettingsHeading')}</h2>
                                            <span className="text-xs bg-surface-page text-text-muted px-2 py-0.5 rounded-[--radius-badge] font-medium">{t('optionalBadge')}</span>
                                        </div>
                                        <p className="text-xs text-text-muted mt-0.5">
                                            {enablePayrollSettings
                                                ? t('configureComponentsDesc')
                                                : t('toggleSetupDesc')}
                                        </p>
                                    </div>
                                </div>

                                <div className="flex items-center gap-3">
                                    {enablePayrollSettings && payrollComponents.length > 0 && (
                                        <span className="text-xs font-semibold text-brand-primary bg-brand-primary-light/25 px-2.5 py-1 rounded-[--radius-badge]">
                                            {t('componentsCountSummary', { count: payrollComponents.length, total: formatCurrency(totalGross) })}
                                        </span>
                                    )}
                                    {/* Toggle pill */}
                                    <div className={`w-12 h-6 rounded-full transition-colors relative flex-shrink-0 ${enablePayrollSettings ? 'bg-brand-primary' : 'bg-surface-border'}`}>
                                        <div className={`absolute top-1 w-4 h-4 bg-surface-card rounded-full shadow-md transition-transform duration-200 ${enablePayrollSettings ? 'translate-x-7' : 'translate-x-1'}`} />
                                    </div>
                                </div>
                            </div>

                            {/* Expanded Content */}
                            {enablePayrollSettings && (
                                <div className="p-5 pt-4 space-y-5 border-t border-brand-primary/10">

                                    {/* Use Global Defaults */}
                                    <div className={`flex items-start gap-3 p-4 rounded-[--radius-card] border transition-colors ${useGlobalDefaults ? 'bg-brand-primary-light/10 border-brand-primary/20' : 'bg-surface-page border-surface-border'}`}>
                                        <input
                                            type="checkbox"
                                            id="useGlobalDefaults"
                                            checked={useGlobalDefaults}
                                            onChange={(e) => handleUseGlobalDefaults(e.target.checked)}
                                            className="mt-0.5 w-4 h-4 text-brand-primary border-surface-border rounded focus:ring-brand-primary cursor-pointer"
                                        />
                                        <label htmlFor="useGlobalDefaults" className="flex-1 cursor-pointer">
                                            <div className="flex items-center gap-2">
                                                <span className="font-semibold text-text-heading text-sm">{t('useGlobalDefaults')}</span>
                                                {useGlobalDefaults && <CheckCircle2 size={14} className="text-brand-primary" />}
                                            </div>
                                            <p className="text-xs text-text-muted mt-0.5 leading-relaxed">
                                                {t('prefillsBasicDesc', { amount: formData.salary ? formatCurrency(parseFloat(formData.salary)) : formatCurrency(0), zero: formatCurrency(0) })}
                                            </p>
                                        </label>
                                    </div>

                                    {/* Salary not entered warning */}
                                    {!formData.salary && (
                                        <div className="flex items-center gap-2 text-xs text-status-warning bg-status-warning-bg/40 border border-status-warning/20 rounded-[--radius-button] p-3">
                                            <AlertCircle size={14} className="flex-shrink-0" />
                                            {t('enterBaseSalaryWarning')}
                                        </div>
                                    )}

                                    {/* Component Editor */}
                                    {payrollComponents.length > 0 && (
                                        <div className="space-y-2">
                                            <div className="flex items-center justify-between mb-1">
                                                <h3 className="text-sm font-semibold text-text-heading">{t('salaryComponentsHeading')}</h3>
                                                <span className="text-xs text-text-muted">{t('componentsItemCount', { count: payrollComponents.length })}</span>
                                            </div>

                                            {payrollComponents.map((comp) => (
                                                <div key={comp.id} className="flex items-center gap-2 p-3 bg-surface-page border border-surface-border rounded-[--radius-button] hover:border-brand-primary/30 transition-colors group">
                                                    {/* Type badge */}
                                                    <span className={`flex-shrink-0 text-xs px-2 py-0.5 rounded-[--radius-badge] font-medium hidden sm:block ${getColorForType(comp.componentType)}`}>
                                                        {comp.componentType}
                                                    </span>

                                                    {/* Type Select */}
                                                    <select
                                                        value={comp.componentType}
                                                        onChange={(e) => updatePayrollComponent(comp.id, 'componentType', e.target.value as ComponentType)}
                                                        className="flex-shrink-0 w-40 px-2 py-2 border border-surface-border rounded-[--radius-input] text-xs focus:ring-2 focus:ring-brand-primary/15 focus:border-brand-primary transition-all bg-surface-card text-text-body"
                                                    >
                                                        {componentTypes.map(opt => (
                                                            <option key={opt} value={opt}>{opt}</option>
                                                        ))}
                                                    </select>

                                                    {/* Amount */}
                                                    <div className="relative flex-1 min-w-0">
                                                        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted text-[10px] pointer-events-none">{getCurrencySymbol()}</span>
                                                        <input
                                                            type="number"
                                                            value={comp.amount || ''}
                                                            onChange={(e) => updatePayrollComponent(comp.id, 'amount', parseFloat(e.target.value) || 0)}
                                                            onWheel={(e) => e.currentTarget.blur()}
                                                            placeholder={t('amountPlaceholder')}
                                                            min="0"
                                                            className="w-full pl-7 pr-2 py-2 border border-surface-border rounded-[--radius-input] text-xs focus:ring-2 focus:ring-brand-primary/15 focus:border-brand-primary transition-all bg-surface-card text-text-body"
                                                        />
                                                    </div>

                                                    {/* Note */}
                                                    <input
                                                        type="text"
                                                        value={comp.note}
                                                        onChange={(e) => updatePayrollComponent(comp.id, 'note', e.target.value)}
                                                        placeholder={t('notePlaceholder')}
                                                        className="flex-1 px-2 py-2 border border-surface-border rounded-[--radius-input] text-xs focus:ring-2 focus:ring-brand-primary/15 focus:border-brand-primary transition-all bg-surface-card text-text-body min-w-0"
                                                    />

                                                    {/* Delete */}
                                                    <button
                                                        type="button"
                                                        onClick={() => removePayrollComponent(comp.id)}
                                                        className="flex-shrink-0 p-1.5 hover:bg-status-error-bg/30 rounded-[--radius-button] text-text-muted/65 group-hover:text-text-muted hover:!text-status-error transition-colors"
                                                    >
                                                        <Trash2 size={14} />
                                                    </button>
                                                </div>
                                            ))}
                                        </div>
                                    )}

                                    {/* Add Component */}
                                    <button
                                        type="button"
                                        onClick={addPayrollComponent}
                                        className="w-full py-2.5 border-2 border-dashed border-brand-primary/20 rounded-[--radius-button] text-brand-primary hover:bg-brand-primary-light/10 hover:border-brand-primary/50 hover:text-brand-primary-dark transition-all flex items-center justify-center gap-2 font-medium text-sm"
                                    >
                                        <Plus size={16} /> {t('addSalaryComponent')}
                                    </button>

                                    {/* Empty state */}
                                    {payrollComponents.length === 0 && (
                                        <div className="text-center py-6 text-text-muted">
                                            <CurrencyIcon size={32} className="mx-auto mb-2 opacity-30" />
                                            <p className="text-sm">{t('noComponentsYet')}</p>
                                            <p className="text-xs mt-1 text-text-muted">{t('toggleGlobalDefaultsHint')}</p>
                                        </div>
                                    )}

                                    {/* ── Deduction Override Toggles ── */}
                                    <div className="rounded-[--radius-card] border border-surface-border overflow-hidden">
                                        <div className="px-4 py-3 bg-surface-page border-b border-surface-border flex items-center justify-between">
                                            <div className="flex items-center gap-2">
                                                <Shield size={14} className="text-text-muted" />
                                                <span className="text-sm font-semibold text-text-heading">{t('deductionSettingsHeading')}</span>
                                                <span className="text-xs text-text-muted font-normal">{t('overrideGlobalForEmployee')}</span>
                                            </div>
                                            {(empPfEnabled !== null || empEsiEnabled !== null || empPtEnabled !== null) && (
                                                <button
                                                    type="button"
                                                    onClick={() => { setEmpPfEnabled(null); setEmpEsiEnabled(null); setEmpPtEnabled(null); }}
                                                    className="text-xs text-brand-primary hover:underline font-medium"
                                                >
                                                    {t('resetToGlobalDefaults')}
                                                </button>
                                            )}
                                        </div>
                                        <div className="divide-y divide-surface-border">
                                            {/* PF Toggle */}
                                            {(() => {
                                                const isOn = empPfEnabled !== null ? empPfEnabled : payrollConfig.pfEnabled;
                                                const isOverridden = empPfEnabled !== null;
                                                return (
                                                    <div className="flex items-center justify-between px-4 py-3.5">
                                                        <div className="flex-1 min-w-0 mr-3">
                                                            <div className="flex items-center gap-2">
                                                                <span className="text-sm font-medium text-text-body">{payrollConfig.pfLabel}</span>
                                                                {isOverridden && (
                                                                    <span className="text-xs bg-brand-accent/15 text-brand-accent-dark px-1.5 py-0.5 rounded-[--radius-badge] font-medium">{t('overridden')}</span>
                                                                )}
                                                            </div>
                                                            <p className="text-xs text-text-muted mt-0.5">
                                                                {payrollConfig.pfEnabled ? `Global: ON · ${Math.round(payrollConfig.pfEmployeeRate * 100)}% on basic` : 'Global: OFF'}
                                                                {isOn && preview.pf > 0 ? ` → employee deduction: ${formatCurrency(preview.pf)}${employeeIsDaily ? ' /mo est.' : '/mo'}` : ''}
                                                            </p>
                                                        </div>
                                                        <button
                                                            type="button"
                                                            onClick={() => setEmpPfEnabled(prev => prev === null ? !payrollConfig.pfEnabled : !prev)}
                                                            className={`relative flex-shrink-0 w-12 h-6 rounded-full transition-colors ${isOn ? 'bg-brand-primary' : 'bg-surface-border'}`}
                                                        >
                                                            <div className={`absolute top-1 w-4 h-4 bg-surface-card rounded-full shadow-md transition-transform ${isOn ? 'translate-x-7' : 'translate-x-1'}`} />
                                                        </button>
                                                    </div>
                                                );
                                            })()}

                                            {/* ESI Toggle */}
                                            {(() => {
                                                const isOn = empEsiEnabled !== null ? empEsiEnabled : payrollConfig.esiEnabled;
                                                const isOverridden = empEsiEnabled !== null;
                                                return (
                                                    <div className="flex items-center justify-between px-4 py-3.5">
                                                        <div className="flex-1 min-w-0 mr-3">
                                                            <div className="flex items-center gap-2">
                                                                <span className="text-sm font-medium text-text-body">{payrollConfig.esiLabel}</span>
                                                                {isOverridden && (
                                                                    <span className="text-xs bg-brand-accent/15 text-brand-accent-dark px-1.5 py-0.5 rounded-[--radius-badge] font-medium">{t('overridden')}</span>
                                                                )}
                                                            </div>
                                                            <p className="text-xs text-text-muted mt-0.5">
                                                                {payrollConfig.esiEnabled ? `Global: ON · ${(payrollConfig.esiEmployeeRate * 100).toFixed(2)}% if gross ≤ ${getCurrencySymbol()}${payrollConfig.esiSalaryCap.toLocaleString()}` : 'Global: OFF'}
                                                                {isOn && preview.esi > 0 ? ` → employee deduction: ${formatCurrency(preview.esi)}${employeeIsDaily ? ' /mo est.' : '/mo'}` : ''}
                                                            </p>
                                                        </div>
                                                        <button
                                                            type="button"
                                                            onClick={() => setEmpEsiEnabled(prev => prev === null ? !payrollConfig.esiEnabled : !prev)}
                                                            className={`relative flex-shrink-0 w-12 h-6 rounded-full transition-colors ${isOn ? 'bg-status-success' : 'bg-surface-border'}`}
                                                        >
                                                            <div className={`absolute top-1 w-4 h-4 bg-surface-card rounded-full shadow-md transition-transform ${isOn ? 'translate-x-7' : 'translate-x-1'}`} />
                                                        </button>
                                                    </div>
                                                );
                                            })()}

                                            {/* Professional Tax Toggle */}
                                            {(() => {
                                                const isOn = empPtEnabled !== null ? empPtEnabled : payrollConfig.professionalTaxEnabled;
                                                const isOverridden = empPtEnabled !== null;
                                                return (
                                                    <div className="flex items-center justify-between px-4 py-3.5">
                                                        <div className="flex-1 min-w-0 mr-3">
                                                            <div className="flex items-center gap-2">
                                                                <span className="text-sm font-medium text-text-body">{t('professionalTax')}</span>
                                                                {isOverridden && (
                                                                    <span className="text-xs bg-brand-accent/15 text-brand-accent-dark px-1.5 py-0.5 rounded-[--radius-badge] font-medium">{t('overridden')}</span>
                                                                )}
                                                            </div>
                                                            <p className="text-xs text-text-muted mt-0.5">
                                                                {payrollConfig.professionalTaxEnabled ? 'Global: ON · monthly slab-based' : 'Global: OFF'}
                                                                {isOn && preview.professionalTax > 0 ? ` → employee deduction: ${formatCurrency(preview.professionalTax)}${employeeIsDaily ? ' /mo est.' : '/mo'}` : ''}
                                                            </p>
                                                        </div>
                                                        <button
                                                            type="button"
                                                            onClick={() => setEmpPtEnabled(prev => prev === null ? !payrollConfig.professionalTaxEnabled : !prev)}
                                                            className={`relative flex-shrink-0 w-12 h-6 rounded-full transition-colors ${isOn ? 'bg-brand-accent' : 'bg-surface-border'}`}
                                                        >
                                                            <div className={`absolute top-1 w-4 h-4 bg-surface-card rounded-full shadow-md transition-transform ${isOn ? 'translate-x-7' : 'translate-x-1'}`} />
                                                        </button>
                                                    </div>
                                                );
                                            })()}
                                        </div>
                                    </div>

                                    {/* Total + Preview CTA */}
                                    {payrollComponents.length > 0 && (
                                        <div className="space-y-3">
                                            {/* Gross total row */}
                                            <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-r from-brand-primary-light/10 to-brand-primary-light/20 border border-brand-primary/20 rounded-[--radius-card]">
                                                <div className="flex items-center gap-2 text-sm font-semibold text-text-body">
                                                    <TrendingUp size={15} className="text-brand-primary" />
                                                    {t('totalGross')}
                                                </div>
                                                <span className="text-lg font-bold text-brand-primary-dark">{formatCurrency(totalGross)}</span>
                                            </div>
                                            {/* Estimated net hint */}
                                            <div className="flex items-center justify-between px-4 py-2.5 bg-status-success-bg/40 border border-status-success/20 rounded-[--radius-card]">
                                                <div className="flex items-center gap-2 text-xs font-medium text-text-muted">
                                                    <TrendingDown size={13} className="text-status-success" />
                                                    {t('estimatedNet')}
                                                </div>
                                                <span className="text-sm font-bold text-status-success">{formatCurrency(preview.netSalary)}</span>
                                            </div>
                                            {/* Preview button */}
                                            <button
                                                type="button"
                                                onClick={() => setShowPayrollPreview(true)}
                                                className="w-full py-3 bg-brand-primary text-text-on-brand rounded-[--radius-button] hover:bg-brand-primary-dark hover:shadow-lg transition-all flex items-center justify-center gap-2 font-semibold text-sm cursor-pointer"
                                            >
                                                <Eye size={16} />
                                                {t('previewPayrollBtn')}
                                            </button>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                        {/* ══ End Payroll Settings ══════════════════════════════════════════════ */}

                        {/* Notes */}
                        <div className="bg-surface-card rounded-[--radius-card] border border-surface-border p-5 shadow-sm">
                            <div className="flex items-center justify-between mb-3">
                                <div className="flex items-center gap-2">
                                    <FileText size={18} className="text-text-muted" />
                                    <h2 className="text-base font-bold text-text-heading">{t('notesHeading')}</h2>
                                </div>
                                <span className="text-xs text-text-muted">{t('optionalBadge')}</span>
                            </div>
                            <textarea
                                value={formData.notes}
                                onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                                rows={3}
                                className="w-full px-3 py-2.5 border border-surface-border rounded-[--radius-input] focus:ring-2 focus:ring-brand-primary/15 focus:border-brand-primary transition-all resize-none text-sm bg-surface-card text-text-body"
                                placeholder={t('notesPlaceholder')}
                            />
                        </div>

                        {/* Form Actions */}
                        <div className="flex gap-3 justify-end pt-2">
                            <button
                                type="button"
                                onClick={() => router.back()}
                                className="px-6 py-2.5 border border-surface-border rounded-[--radius-button] hover:bg-surface-page transition-all font-semibold text-text-body text-sm cursor-pointer"
                            >
                                {t('cancelBtn')}
                            </button>
                            <button
                                data-testid="con-form-submit"
                                type="submit"
                                disabled={loading}
                                className="flex items-center gap-2 px-6 py-2.5 bg-brand-primary text-text-on-brand rounded-[--radius-button] hover:bg-brand-primary-dark hover:shadow-lg transition-all font-semibold disabled:opacity-50 disabled:cursor-not-allowed text-sm cursor-pointer"
                            >
                                {loading ? (
                                    <>
                                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-text-on-brand" />
                                        {savingPayroll ? t('savingPayrollSettings') : t('creatingContractLoading')}
                                    </>
                                ) : (
                                    <>
                                        <FileSignature size={18} />
                                        {enablePayrollSettings && payrollComponents.length > 0
                                            ? t('createContractAndPayrollBtn')
                                            : t('creatingContractBtn')}
                                    </>
                                )}
                            </button>
                        </div>
                    </form>
                </div>

                {/* ══════════════════════════════════════════════════════════════════════════
                    PAYROLL PREVIEW MODAL
                ══════════════════════════════════════════════════════════════════════════ */}
                {showPayrollPreview && (
                    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-start justify-center z-50 p-4 overflow-y-auto">
                        <div className="bg-surface-card rounded-[--radius-card] w-full max-w-3xl my-6 shadow-2xl overflow-hidden">

                            {/* Modal Header */}
                            <div className="bg-brand-primary px-6 py-5 text-text-on-brand">
                                <div className="flex items-center justify-between">
                                    <div>
                                        <div className="flex items-center gap-2 mb-1">
                                            <Shield size={18} />
                                            <h3 className="text-lg font-bold">{t('previewModalTitle')}</h3>
                                        </div>
                                        {selectedEmployee && (
                                            <p className="text-text-on-brand/85 text-sm">
                                                {selectedEmployee.fullName} · {selectedEmployee.employeeCode} · {selectedEmployee.position}
                                            </p>
                                        )}
                                    </div>
                                    <button
                                        onClick={() => setShowPayrollPreview(false)}
                                        className="p-2 hover:bg-text-on-brand/10 rounded-[--radius-button] transition-colors"
                                    >
                                        <X size={20} />
                                    </button>
                                </div>
                            </div>

                            <div className="p-6 space-y-5 max-h-[72vh] overflow-y-auto">

                                {/* Earnings + Deductions — 2 columns */}
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

                                    {/* Earnings */}
                                    <div className="bg-status-success-bg/40 border border-status-success/20 rounded-[--radius-card] p-4">
                                        <h4 className="text-sm font-bold text-status-success mb-3 flex items-center gap-1.5">
                                            <TrendingUp size={15} /> {t('earningsMonthly')}
                                        </h4>
                                        <div className="space-y-2.5">
                                            {payrollComponents.map((comp) => (
                                                <div key={comp.id} className="flex items-center justify-between text-sm">
                                                    <div className="flex items-center gap-1.5 min-w-0 flex-1 mr-2">
                                                        <span className={`flex-shrink-0 text-xs px-1.5 py-0.5 rounded-[--radius-badge] font-medium ${getColorForType(comp.componentType)}`}>
                                                            {comp.componentType}
                                                        </span>
                                                        {comp.note && <span className="text-xs text-text-muted truncate">({comp.note})</span>}
                                                    </div>
                                                    <span className="font-semibold text-text-heading flex-shrink-0">{formatCurrency(comp.amount)}</span>
                                                </div>
                                            ))}
                                        </div>
                                        <div className="mt-3 pt-3 border-t border-status-success/20 flex items-center justify-between">
                                            <span className="text-sm font-bold text-status-success">{t('grossTotal')}</span>
                                            <span className="text-base font-bold text-status-success">{formatCurrency(preview.grossSalary)}</span>
                                        </div>
                                    </div>

                                    {/* Deductions */}
                                    <div className="bg-status-error-bg/40 border border-status-error/20 rounded-[--radius-card] p-4">
                                        <h4 className="text-sm font-bold text-status-error mb-3 flex items-center gap-1.5">
                                            <TrendingDown size={15} /> {t('deductionsMonthly')}
                                        </h4>
                                        <div className="space-y-3">
                                            {/* PF */}
                                            <div className="space-y-0.5">
                                                <div className="flex items-center justify-between text-sm">
                                                    <div className="flex items-center gap-1.5 flex-wrap">
                                                        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${effectiveConfig.pfEnabled ? 'bg-brand-primary' : 'bg-surface-border'}`} />
                                                        <span className="text-text-body text-xs font-medium">{t('pfLabel')}</span>
                                                        <span className={`text-xs px-1.5 py-0.5 rounded font-bold ${effectiveConfig.pfEnabled ? 'bg-brand-primary-light/20 text-brand-primary' : 'bg-surface-page text-text-muted'}`}>
                                                            {effectiveConfig.pfEnabled ? 'ON' : 'OFF'}
                                                        </span>
                                                        {empPfEnabled !== null && <span className="text-xs bg-brand-accent/15 text-brand-accent-dark px-1.5 py-0.5 rounded font-medium">{t('overridden')}</span>}
                                                    </div>
                                                    <span className={`font-semibold text-sm flex-shrink-0 ml-1 ${effectiveConfig.pfEnabled ? 'text-status-error' : 'text-text-muted'}`}>
                                                        {effectiveConfig.pfEnabled ? `-${formatCurrency(preview.pf)}` : '—'}
                                                    </span>
                                                </div>
                                                {effectiveConfig.pfEnabled && (
                                                    <p className="text-xs text-text-muted pl-4">{payrollConfig.pfLabel} · {Math.round(payrollConfig.pfEmployeeRate * 100)}%{payrollConfig.pfSalaryCap > 0 ? ` (cap ${getCurrencySymbol()}${payrollConfig.pfSalaryCap.toLocaleString()})` : ''}</p>
                                                )}
                                            </div>

                                            {/* ESI */}
                                            <div className="space-y-0.5">
                                                <div className="flex items-center justify-between text-sm">
                                                    <div className="flex items-center gap-1.5 flex-wrap">
                                                        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${effectiveConfig.esiEnabled ? 'bg-status-success' : 'bg-surface-border'}`} />
                                                        <span className="text-text-body text-xs font-medium">{t('esiLabel')}</span>
                                                        <span className={`text-xs px-1.5 py-0.5 rounded font-bold ${effectiveConfig.esiEnabled ? 'bg-status-success-bg text-status-success' : 'bg-surface-page text-text-muted'}`}>
                                                            {effectiveConfig.esiEnabled ? 'ON' : 'OFF'}
                                                        </span>
                                                        {empEsiEnabled !== null && <span className="text-xs bg-brand-accent/15 text-brand-accent-dark px-1.5 py-0.5 rounded font-medium">{t('overridden')}</span>}
                                                    </div>
                                                    <span className={`font-semibold text-sm flex-shrink-0 ml-1 ${effectiveConfig.esiEnabled && preview.esi > 0 ? 'text-status-error' : 'text-text-muted'}`}>
                                                        {effectiveConfig.esiEnabled ? (preview.esi > 0 ? `-${formatCurrency(preview.esi)}` : `${formatCurrency(0)} (above cap)`) : '—'}
                                                    </span>
                                                </div>
                                                {effectiveConfig.esiEnabled && (
                                                    <p className="text-xs text-text-muted pl-4">{payrollConfig.esiLabel} · {(payrollConfig.esiEmployeeRate * 100).toFixed(2)}%{payrollConfig.esiSalaryCap > 0 ? ` (if gross ≤ ${getCurrencySymbol()}${payrollConfig.esiSalaryCap.toLocaleString()})` : ''}</p>
                                                )}
                                            </div>

                                            {/* Professional Tax */}
                                            <div className="space-y-0.5">
                                                <div className="flex items-center justify-between text-sm">
                                                    <div className="flex items-center gap-1.5 flex-wrap">
                                                        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${effectiveConfig.professionalTaxEnabled ? 'bg-brand-accent' : 'bg-surface-border'}`} />
                                                        <span className="text-text-body text-xs font-medium">{t('professionalTax')}</span>
                                                        <span className={`text-xs px-1.5 py-0.5 rounded font-bold ${effectiveConfig.professionalTaxEnabled ? 'bg-brand-accent/15 text-brand-accent-dark' : 'bg-surface-page text-text-muted'}`}>
                                                            {effectiveConfig.professionalTaxEnabled ? 'ON' : 'OFF'}
                                                        </span>
                                                        {empPtEnabled !== null && <span className="text-xs bg-brand-accent/15 text-brand-accent-dark px-1.5 py-0.5 rounded font-medium">{t('overridden')}</span>}
                                                    </div>
                                                    <span className={`font-semibold text-sm flex-shrink-0 ml-1 ${effectiveConfig.professionalTaxEnabled && preview.professionalTax > 0 ? 'text-status-error' : 'text-text-muted'}`}>
                                                        {effectiveConfig.professionalTaxEnabled ? `-${formatCurrency(preview.professionalTax)}` : '—'}
                                                    </span>
                                                </div>
                                                {effectiveConfig.professionalTaxEnabled && (
                                                    <p className="text-xs text-text-muted pl-4">Monthly slab based on gross salary</p>
                                                )}
                                            </div>

                                            {/* Income Tax */}
                                            <div className="space-y-0.5">
                                                <div className="flex items-center justify-between text-sm">
                                                    <div className="flex items-center gap-1.5">
                                                        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${payrollConfig.taxEnabled ? 'bg-status-info' : 'bg-surface-border'}`} />
                                                        <span className="text-text-body text-xs font-medium">{payrollConfig.taxLabel}</span>
                                                        <span className={`text-xs px-1.5 py-0.5 rounded font-bold ${payrollConfig.taxEnabled ? 'bg-status-info-bg text-status-info' : 'bg-surface-page text-text-muted'}`}>
                                                            {payrollConfig.taxEnabled ? 'ON' : 'OFF'}
                                                        </span>
                                                    </div>
                                                    <span className={`font-semibold text-sm ${payrollConfig.taxEnabled && preview.tax > 0 ? 'text-status-error' : 'text-text-muted'}`}>
                                                        {payrollConfig.taxEnabled ? `-${formatCurrency(preview.tax)}` : '—'}
                                                    </span>
                                                </div>
                                                {payrollConfig.taxEnabled && (
                                                    <p className="text-xs text-text-muted pl-4">
                                                        {payrollConfig.taxRegime === 'new' ? 'New Tax Regime' : payrollConfig.taxRegime === 'old' ? 'Old Tax Regime' : 'Progressive Slabs'}
                                                        {' · '}Std. deduction {getCurrencySymbol()}{payrollConfig.standardDeduction.toLocaleString()}/yr
                                                        {payrollConfig.taxRebateEnabled && ` · 87A Rebate if taxable ≤ ${getCurrencySymbol()}${payrollConfig.taxRebateLimit.toLocaleString()}/yr`}
                                                        {payrollConfig.cessEnabled && preview.tax > 0 && ` · Cess ${Math.round(payrollConfig.cessRate * 100)}% included`}
                                                    </p>
                                                )}
                                            </div>
                                        </div>

                                        <div className="mt-3 pt-3 border-t border-status-error/20 flex items-center justify-between">
                                            <span className="text-sm font-bold text-status-error">{t('totalDeductions')}</span>
                                            <span className="text-base font-bold text-status-error">-{formatCurrency(preview.totalDeductions)}</span>
                                        </div>
                                    </div>
                                </div>

                                {/* Net Salary Highlight */}
                                <div className="bg-status-success rounded-[--radius-card] p-5 text-text-on-brand">
                                    <div className="flex items-center justify-between">
                                        <div>
                                            <p className="text-text-on-brand/85 text-xs uppercase tracking-wider mb-1">{t('estimatedTakeHome')}</p>
                                            <p className="text-4xl font-bold">{formatCurrency(preview.netSalary)}</p>
                                        </div>
                                        <div className="text-right space-y-1">
                                            <div className="text-text-on-brand/80 text-xs">{t('grossPrefix', { amount: formatCurrency(preview.grossSalary) })}</div>
                                            <div className="text-text-on-brand/80 text-xs">{t('deductionsPrefix', { amount: formatCurrency(preview.totalDeductions) })}</div>
                                        </div>
                                    </div>
                                </div>

                                {/* Payroll Config Details (collapsible) */}
                                <div className="border border-surface-border rounded-[--radius-card] overflow-hidden">
                                    <button
                                        type="button"
                                        onClick={() => setShowConfigInfo(!showConfigInfo)}
                                        className="w-full flex items-center justify-between px-4 py-3 bg-surface-page hover:bg-surface-page transition-colors text-sm font-medium text-text-body"
                                    >
                                        <div className="flex items-center gap-2">
                                            <Info size={15} className="text-text-muted" />
                                            {t('appliedPayrollConfig')}
                                        </div>
                                        {showConfigInfo ? <ChevronUp size={15} className="text-text-muted" /> : <ChevronDown size={15} className="text-text-muted" />}
                                    </button>

                                    {showConfigInfo && (
                                        <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs border-t border-surface-border">
                                            {/* PF Block */}
                                            <div className={`p-3 rounded-[--radius-button] border ${payrollConfig.pfEnabled ? 'bg-brand-primary-light/10 border-brand-primary/20' : 'bg-surface-page border-surface-border opacity-60'}`}>
                                                <div className="flex items-center justify-between mb-1.5">
                                                    <span className="font-semibold text-text-body">{t('pfLabel')}</span>
                                                    <span className={`px-2 py-0.5 rounded text-xs font-bold ${payrollConfig.pfEnabled ? 'bg-brand-primary-light/20 text-brand-primary' : 'bg-surface-border text-text-muted'}`}>
                                                        {payrollConfig.pfEnabled ? 'ENABLED' : 'DISABLED'}
                                                    </span>
                                                </div>
                                                <p className="text-text-muted mb-1">{payrollConfig.pfLabel}</p>
                                                {payrollConfig.pfEnabled && (
                                                    <ul className="space-y-0.5 text-text-body">
                                                        <li>· Employee rate: {Math.round(payrollConfig.pfEmployeeRate * 100)}%</li>
                                                        {payrollConfig.pfSalaryCap > 0 && <li>· Salary cap: {getCurrencySymbol()}{payrollConfig.pfSalaryCap.toLocaleString()}</li>}
                                                    </ul>
                                                )}
                                            </div>
                                            {/* ESI Block */}
                                            <div className={`p-3 rounded-[--radius-button] border ${payrollConfig.esiEnabled ? 'bg-status-success-bg/40 border-status-success/20' : 'bg-surface-page border-surface-border opacity-60'}`}>
                                                <div className="flex items-center justify-between mb-1.5">
                                                    <span className="font-semibold text-text-body">{t('esiLabel')}</span>
                                                    <span className={`px-2 py-0.5 rounded text-xs font-bold ${payrollConfig.esiEnabled ? 'bg-status-success-bg text-status-success' : 'bg-surface-border text-text-muted'}`}>
                                                        {payrollConfig.esiEnabled ? 'ENABLED' : 'DISABLED'}
                                                    </span>
                                                </div>
                                                <p className="text-text-muted mb-1">{payrollConfig.esiLabel}</p>
                                                {payrollConfig.esiEnabled && (
                                                    <ul className="space-y-0.5 text-text-body">
                                                        <li>· Employee rate: {(payrollConfig.esiEmployeeRate * 100).toFixed(2)}%</li>
                                                        {payrollConfig.esiSalaryCap > 0 && <li>· Applies if gross ≤ {getCurrencySymbol()}{payrollConfig.esiSalaryCap.toLocaleString()}</li>}
                                                    </ul>
                                                )}
                                            </div>
                                            {/* PT Block */}
                                            <div className={`p-3 rounded-[--radius-button] border ${payrollConfig.professionalTaxEnabled ? 'bg-brand-accent/10 border-brand-accent/20' : 'bg-surface-page border-surface-border opacity-60'}`}>
                                                <div className="flex items-center justify-between mb-1.5">
                                                    <span className="font-semibold text-text-body">{t('professionalTax')}</span>
                                                    <span className={`px-2 py-0.5 rounded text-xs font-bold ${payrollConfig.professionalTaxEnabled ? 'bg-brand-accent/15 text-brand-accent-dark' : 'bg-surface-border text-text-muted'}`}>
                                                        {payrollConfig.professionalTaxEnabled ? 'ENABLED' : 'DISABLED'}
                                                    </span>
                                                </div>
                                                {payrollConfig.professionalTaxEnabled ? (
                                                    <p className="text-text-body">Monthly: {getCurrencySymbol()}{preview.professionalTax.toLocaleString()} (slab-based)</p>
                                                ) : (
                                                    <p className="text-text-muted">Not applicable</p>
                                                )}
                                            </div>
                                            {/* Tax Block */}
                                            <div className={`p-3 rounded-[--radius-button] border ${payrollConfig.taxEnabled ? 'bg-status-info-bg/40 border-status-info/20' : 'bg-surface-page border-surface-border opacity-60'}`}>
                                                <div className="flex items-center justify-between mb-1.5">
                                                    <span className="font-semibold text-text-body">Income Tax / TDS</span>
                                                    <span className={`px-2 py-0.5 rounded text-xs font-bold ${payrollConfig.taxEnabled ? 'bg-status-info-bg text-status-info' : 'bg-surface-border text-text-muted'}`}>
                                                        {payrollConfig.taxEnabled ? 'ENABLED' : 'DISABLED'}
                                                    </span>
                                                </div>
                                                {payrollConfig.taxEnabled && (
                                                    <ul className="space-y-0.5 text-text-body">
                                                        <li>· Regime: {payrollConfig.taxRegime === 'new' ? 'New Tax Regime' : payrollConfig.taxRegime === 'old' ? 'Old Tax Regime' : 'Progressive'}</li>
                                                        <li>· Std. deduction: {getCurrencySymbol()}{payrollConfig.standardDeduction.toLocaleString()}/yr</li>
                                                        {payrollConfig.taxRebateEnabled && <li>· 87A Rebate: if taxable ≤ {getCurrencySymbol()}{payrollConfig.taxRebateLimit.toLocaleString()}/yr</li>}
                                                        {payrollConfig.cessEnabled && <li>· Cess: {Math.round(payrollConfig.cessRate * 100)}% on income tax</li>}
                                                    </ul>
                                                )}
                                            </div>
                                        </div>
                                    )}
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
                                    className="flex-1 px-4 py-2.5 border border-surface-border bg-surface-card rounded-[--radius-button] hover:bg-surface-page transition-all font-semibold text-text-body text-sm flex items-center justify-center gap-2 cursor-pointer"
                                >
                                    <ArrowLeft size={15} /> {t('backAndEdit')}
                                </button>
                                <button
                                    type="button"
                                    disabled={loading}
                                    onClick={() => {
                                        setShowPayrollPreview(false);
                                        // Small delay to let modal close, then submit
                                        setTimeout(() => formRef.current?.requestSubmit(), 50);
                                    }}
                                    className="flex-1 px-4 py-2.5 bg-brand-primary text-text-on-brand rounded-[--radius-button] hover:bg-brand-primary-dark transition-all font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-50 cursor-pointer"
                                >
                                    <CheckCircle2 size={15} />
                                    {t('saveContractAndPayroll')}
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </>
        </ProtectedRoute>
    );
}

function NewContractLoadingFallback() {
    const t = useTranslations('newContractPage');
    return (
        <div className="flex items-center justify-center h-screen">
            <div className="text-center">
                <div className="animate-spin rounded-full h-12 w-12 border-b-4 border-brand-primary mx-auto mb-4"></div>
                <p className="text-text-muted font-medium">{t('loading')}</p>
            </div>
        </div>
    );
}

export default function NewContractPage() {
    return (
        <Suspense fallback={<NewContractLoadingFallback />}>
            <NewContractForm />
        </Suspense>
    );
}

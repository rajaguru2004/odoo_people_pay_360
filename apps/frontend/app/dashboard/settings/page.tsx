'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Settings, Bell, Shield, Palette, Globe, Key, Save, Clock, Calendar,
  Sliders, Mail, Server, Hash, User, Lock, Tag, Plus, Trash2,
  Percent, TrendingUp, BarChart2, Building2, CheckCircle2, Info, Edit3, RotateCcw,
  ListTodo, BookOpen, MoreVertical, X, MapPin, AlertTriangle,
  Loader2, Database, Sparkles, GitBranch,
} from 'lucide-react';
import { CurrencyIcon } from '@/components/common/CurrencyIcon';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuthStore } from '@/store/authStore';
import systemSettingsService, { CountryPreset } from '@/services/systemSettingsService';
import axiosInstance from '@/lib/axios';
import { useBranchStore } from '@/store/branchStore';
import libraryService, { LibraryTypeValue } from '@/services/libraryService';
import employeeService from '@/services/employeeService';
import { toast } from 'sonner';
import { useBrandingStore } from '@/store/brandingStore';
import authService from '@/services/authService';
import { passwordSchema } from '@/utils/validators';
import { getGroupedTimezones, utcOffsetLabel, nowTimeStr } from '@/utils/tzDate';
import TimezoneSelect from '@/components/common/TimezoneSelect';
import { THEME_PRESETS, getPreset } from '@/theme/presets';
import { THEME_FONTS } from '@/theme/fonts';
import { CUSTOM_COLOR_KEYS } from '@/theme/resolveTheme';
import { DashboardVersion } from '@/utils/dashboardPreference';
import { setDefaultCurrency, setDefaultDateFormat } from '@/utils/formatters';
import HolidaysManager from '@/components/holidays/HolidaysManager';
import CopilotSettingsSection from '@/components/settings/CopilotSettingsSection';
import SupervisorHierarchySection from '@/components/settings/SupervisorHierarchySection';
import OvertimePolicySection from '@/components/settings/OvertimePolicySection';
import { useDevMode } from '@/hooks/useDevMode';
import { usePageHeader } from '@/hooks/usePageHeader';
import PageActionRow from '@/components/common/PageActionRow';
import { currentDevToken } from '@/store/devModeStore';
import DevModeToggle from '@/components/dev-mode/DevModeToggle';
import {
  PAYROLL_FEATURE_SWITCHES,
  PayrollFeatureSwitches,
} from '@/components/settings/PayrollFeatureSwitches';

/**
 * Tabs that only exist while developer mode is unlocked. Kept as one list so the
 * nav, the render guards and the expiry bounce cannot drift apart.
 */
/**
 * Tabs that save through their OWN controls, and must not be offered the
 * footer save bar.
 *
 * Two groups, one rule. `libraries`, `employee-template`, `copilot`, `messages`
 * and `integrations` were always excluded. The rest were not, and that was the
 * bug: the footer rendered on them and `handleSave` silently did nothing except
 * report success.
 */
const SELF_SAVING_TABS = new Set([
  'libraries',
  'copilot',
  // Added — each has its own panel or its own submit button.
  'holidays',
  'approvals',
  'overtime-policies',
  'security',
]);

const DEVELOPER_TAB_IDS = ['copilot'];

/** The one panel every tab renders into — the rail's `aria-controls` target. */
const SETTINGS_PANEL_ID = 'settings-panel';

interface SettingsTab {
  id: string;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  /** Shown on hover: what the tab holds, so the label need not carry it all. */
  hint: string;
}

interface SettingsTabGroup {
  id: string;
  label: string;
  tabs: SettingsTab[];
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface PtSlab { upTo: number; tax: number }
interface TaxBracket { limit: number; rate: number }

interface PayrollSettings {
  payroll_country: string;
  payroll_currency: string;
  payroll_currency_symbol: string;
  // Display preference ('symbol' | 'code'), independent of country statutory
  // presets — optional so applying a preset never resets the user's choice.
  payroll_currency_display?: string;
  payroll_work_hours_per_day: string;
  payroll_work_days_per_week: string;
  payroll_overtime_rate: string;
  payroll_basic_salary_percentage: string;
  // PF
  payroll_pf_enabled: boolean;
  payroll_pf_employee_rate: string;
  payroll_pf_employer_rate: string;
  payroll_pf_salary_cap: string;
  payroll_pf_on_full_salary: boolean;
  // PT
  payroll_professional_tax_enabled: boolean;
  payroll_professional_tax_slabs: PtSlab[];
  // TDS
  payroll_tax_regime: string;
  payroll_standard_deduction: string;
  payroll_personal_deduction_monthly: string;
  payroll_tax_calculation_period: string;
  payroll_tax_brackets: TaxBracket[];
  payroll_tax_rebate_enabled: boolean;
  payroll_tax_rebate_limit: string;
  payroll_cess_enabled: boolean;
  payroll_cess_rate: string;
  // ESI
  payroll_esi_enabled: boolean;
  payroll_esi_employee_rate: string;
  payroll_esi_employer_rate: string;
  payroll_esi_salary_cap: string;
  // Gratuity
  // Daily wage
  payroll_daily_wage_statutory_deductions: boolean;
  payroll_daily_wage_pay_leave: boolean;
  payroll_daily_wage_pay_holidays: boolean;
}

// ─── Custom Labels ────────────────────────────────────────────────────────────

type LabelKey =
  | 'payroll_label_general'
  | 'payroll_label_pf'
  | 'payroll_label_pf_employee_rate'
  | 'payroll_label_pf_employer_rate'
  | 'payroll_label_pf_cap'
  | 'payroll_label_esi'
  | 'payroll_label_esi_employee_rate'
  | 'payroll_label_esi_employer_rate'
  | 'payroll_label_esi_cap'
  | 'payroll_label_pt'
  | 'payroll_label_income_tax'
  | 'payroll_label_cess'
  | 'payroll_label_rebate'

type PayrollLabels = Record<LabelKey, string>;

const EMPTY_LABELS: PayrollLabels = {
  payroll_label_general: '',
  payroll_label_pf: '',
  payroll_label_pf_employee_rate: '',
  payroll_label_pf_employer_rate: '',
  payroll_label_pf_cap: '',
  payroll_label_esi: '',
  payroll_label_esi_employee_rate: '',
  payroll_label_esi_employer_rate: '',
  payroll_label_esi_cap: '',
  payroll_label_pt: '',
  payroll_label_income_tax: '',
  payroll_label_cess: '',
  payroll_label_rebate: '',
};

interface CountryMetaFull {
  flag: string; name: string; tag: string;
  pfLabel: string; ptLabel: string; esiLabel: string;
  cessLabel: string; rebateLabel: string;
}

/** Every editable label with its metadata and country-meta default resolver. */
const LABEL_ENTRIES: {
  key: LabelKey;
  category: string;
  description: string;
  getDefault: (meta: CountryMetaFull) => string;
}[] = [
    // ─── Section titles ───────────────────────────────────────────────────────
    { key: 'payroll_label_general', category: 'Section title', description: 'General Payroll section heading', getDefault: () => 'General Payroll' },
    { key: 'payroll_label_pf', category: 'Section title', description: 'Social Insurance / Provident Fund section', getDefault: m => m.pfLabel },
    { key: 'payroll_label_esi', category: 'Section title', description: 'Health Insurance / ESI section', getDefault: m => m.esiLabel },
    { key: 'payroll_label_pt', category: 'Section title', description: 'Regional / Professional Tax section', getDefault: m => m.ptLabel },
    { key: 'payroll_label_income_tax', category: 'Section title', description: 'Income Tax / TDS section heading', getDefault: () => 'Income Tax / TDS' },
    { key: 'payroll_label_cess', category: 'Section title', description: 'Surcharge / Cess block title', getDefault: m => m.cessLabel },
    { key: 'payroll_label_rebate', category: 'Section title', description: 'Tax Rebate / Credit block title', getDefault: m => m.rebateLabel },
    // ─── PF field labels ──────────────────────────────────────────────────────
    { key: 'payroll_label_pf_employee_rate', category: 'PF field', description: 'Employee contribution rate field inside PF', getDefault: () => 'Employee Contribution Rate' },
    { key: 'payroll_label_pf_employer_rate', category: 'PF field', description: 'Employer contribution rate field inside PF', getDefault: () => 'Employer Contribution Rate' },
    { key: 'payroll_label_pf_cap', category: 'PF field', description: 'Salary cap / wage ceiling field inside PF', getDefault: () => 'Salary Cap' },
    // ─── ESI field labels ─────────────────────────────────────────────────────
    { key: 'payroll_label_esi_employee_rate', category: 'ESI field', description: 'Employee rate field inside ESI/Health Insurance', getDefault: () => 'Employee Rate' },
    { key: 'payroll_label_esi_employer_rate', category: 'ESI field', description: 'Employer rate field inside ESI/Health Insurance', getDefault: () => 'Employer Rate' },
    { key: 'payroll_label_esi_cap', category: 'ESI field', description: 'Salary cap / threshold field inside ESI', getDefault: () => 'Gross Salary Cap' },
  ];

// ─── Country Presets (frontend state) ────────────────────────────────────────

// The daily-wage statutory toggle is a company policy, not a country rule, so
// presets deliberately omit it and applying a country preset leaves it alone.
type CountryPresetSettings = Omit<
  PayrollSettings,
  | 'payroll_daily_wage_statutory_deductions'
  | 'payroll_daily_wage_pay_leave'
  | 'payroll_daily_wage_pay_holidays'
>;

const COUNTRY_PRESETS: Record<CountryPreset, CountryPresetSettings> = {
  IN: {
    payroll_country: 'IN', payroll_currency: 'INR', payroll_currency_symbol: '₹',
    payroll_work_hours_per_day: '8', payroll_work_days_per_week: '5', payroll_overtime_rate: '1.5', payroll_basic_salary_percentage: '40',
    payroll_pf_enabled: true, payroll_pf_employee_rate: '0.12', payroll_pf_employer_rate: '0.12', payroll_pf_salary_cap: '15000', payroll_pf_on_full_salary: false,
    payroll_professional_tax_enabled: true,
    payroll_professional_tax_slabs: [{ upTo: 10000, tax: 0 }, { upTo: 15000, tax: 110 }, { upTo: 20000, tax: 130 }, { upTo: 25000, tax: 150 }, { upTo: 999999999, tax: 200 }],
    payroll_tax_regime: 'new', payroll_standard_deduction: '75000', payroll_personal_deduction_monthly: '6250', payroll_tax_calculation_period: 'annual',
    payroll_tax_brackets: [{ limit: 300000, rate: 0 }, { limit: 700000, rate: 0.05 }, { limit: 1000000, rate: 0.1 }, { limit: 1200000, rate: 0.15 }, { limit: 1500000, rate: 0.2 }, { limit: 999999999, rate: 0.3 }],
    payroll_tax_rebate_enabled: true, payroll_tax_rebate_limit: '700000', payroll_cess_enabled: true, payroll_cess_rate: '0.04',
    payroll_esi_enabled: true, payroll_esi_employee_rate: '0.0075', payroll_esi_employer_rate: '0.0325', payroll_esi_salary_cap: '21000',
  },
  US: {
    payroll_country: 'US', payroll_currency: 'USD', payroll_currency_symbol: '$',
    payroll_work_hours_per_day: '8', payroll_work_days_per_week: '5', payroll_overtime_rate: '1.5', payroll_basic_salary_percentage: '100',
    payroll_pf_enabled: true, payroll_pf_employee_rate: '0.0765', payroll_pf_employer_rate: '0.0765', payroll_pf_salary_cap: '168600', payroll_pf_on_full_salary: false,
    payroll_professional_tax_enabled: false, payroll_professional_tax_slabs: [],
    payroll_tax_regime: 'progressive', payroll_standard_deduction: '14600', payroll_personal_deduction_monthly: '1217', payroll_tax_calculation_period: 'annual',
    payroll_tax_brackets: [{ limit: 11600, rate: 0.10 }, { limit: 47150, rate: 0.12 }, { limit: 100525, rate: 0.22 }, { limit: 191950, rate: 0.24 }, { limit: 243725, rate: 0.32 }, { limit: 609350, rate: 0.35 }, { limit: 999999999, rate: 0.37 }],
    payroll_tax_rebate_enabled: false, payroll_tax_rebate_limit: '0', payroll_cess_enabled: false, payroll_cess_rate: '0',
    payroll_esi_enabled: false, payroll_esi_employee_rate: '0', payroll_esi_employer_rate: '0', payroll_esi_salary_cap: '0',
  },
  GB: {
    payroll_country: 'GB', payroll_currency: 'GBP', payroll_currency_symbol: '£',
    payroll_work_hours_per_day: '8', payroll_work_days_per_week: '5', payroll_overtime_rate: '1.5', payroll_basic_salary_percentage: '100',
    payroll_pf_enabled: true, payroll_pf_employee_rate: '0.08', payroll_pf_employer_rate: '0.138', payroll_pf_salary_cap: '0', payroll_pf_on_full_salary: true,
    payroll_professional_tax_enabled: false, payroll_professional_tax_slabs: [],
    payroll_tax_regime: 'progressive', payroll_standard_deduction: '12570', payroll_personal_deduction_monthly: '1048', payroll_tax_calculation_period: 'annual',
    payroll_tax_brackets: [{ limit: 12570, rate: 0.0 }, { limit: 50270, rate: 0.20 }, { limit: 125140, rate: 0.40 }, { limit: 999999999, rate: 0.45 }],
    payroll_tax_rebate_enabled: false, payroll_tax_rebate_limit: '0', payroll_cess_enabled: false, payroll_cess_rate: '0',
    payroll_esi_enabled: false, payroll_esi_employee_rate: '0', payroll_esi_employer_rate: '0', payroll_esi_salary_cap: '0',
  },
  AE: {
    payroll_country: 'AE', payroll_currency: 'AED', payroll_currency_symbol: 'د.إ',
    payroll_work_hours_per_day: '8', payroll_work_days_per_week: '5', payroll_overtime_rate: '1.25', payroll_basic_salary_percentage: '60',
    payroll_pf_enabled: false, payroll_pf_employee_rate: '0.05', payroll_pf_employer_rate: '0.125', payroll_pf_salary_cap: '0', payroll_pf_on_full_salary: false,
    payroll_professional_tax_enabled: false, payroll_professional_tax_slabs: [],
    payroll_tax_regime: 'progressive', payroll_standard_deduction: '0', payroll_personal_deduction_monthly: '0', payroll_tax_calculation_period: 'annual',
    payroll_tax_brackets: [{ limit: 999999999, rate: 0.0 }],
    payroll_tax_rebate_enabled: false, payroll_tax_rebate_limit: '0', payroll_cess_enabled: false, payroll_cess_rate: '0',
    payroll_esi_enabled: false, payroll_esi_employee_rate: '0', payroll_esi_employer_rate: '0', payroll_esi_salary_cap: '0',
  },
  OM: {
    payroll_country: 'OM', payroll_currency: 'OMR', payroll_currency_symbol: 'ر.ع.',
    payroll_work_hours_per_day: '8', payroll_work_days_per_week: '5', payroll_overtime_rate: '1.25', payroll_basic_salary_percentage: '60',
    payroll_pf_enabled: false, payroll_pf_employee_rate: '0.08', payroll_pf_employer_rate: '0.145', payroll_pf_salary_cap: '3000', payroll_pf_on_full_salary: false,
    payroll_professional_tax_enabled: false, payroll_professional_tax_slabs: [],
    payroll_tax_regime: 'progressive', payroll_standard_deduction: '0', payroll_personal_deduction_monthly: '0', payroll_tax_calculation_period: 'annual',
    payroll_tax_brackets: [{ limit: 999999999, rate: 0.0 }],
    payroll_tax_rebate_enabled: false, payroll_tax_rebate_limit: '0', payroll_cess_enabled: false, payroll_cess_rate: '0',
    payroll_esi_enabled: false, payroll_esi_employee_rate: '0', payroll_esi_employer_rate: '0', payroll_esi_salary_cap: '0',
  },
  SG: {
    payroll_country: 'SG', payroll_currency: 'SGD', payroll_currency_symbol: 'S$',
    payroll_work_hours_per_day: '8', payroll_work_days_per_week: '5', payroll_overtime_rate: '1.5', payroll_basic_salary_percentage: '100',
    payroll_pf_enabled: true, payroll_pf_employee_rate: '0.20', payroll_pf_employer_rate: '0.17', payroll_pf_salary_cap: '6800', payroll_pf_on_full_salary: false,
    payroll_professional_tax_enabled: false, payroll_professional_tax_slabs: [],
    payroll_tax_regime: 'progressive', payroll_standard_deduction: '0', payroll_personal_deduction_monthly: '0', payroll_tax_calculation_period: 'annual',
    payroll_tax_brackets: [{ limit: 20000, rate: 0.0 }, { limit: 30000, rate: 0.02 }, { limit: 40000, rate: 0.035 }, { limit: 80000, rate: 0.07 }, { limit: 120000, rate: 0.115 }, { limit: 160000, rate: 0.15 }, { limit: 200000, rate: 0.18 }, { limit: 240000, rate: 0.19 }, { limit: 280000, rate: 0.195 }, { limit: 320000, rate: 0.20 }, { limit: 999999999, rate: 0.22 }],
    payroll_tax_rebate_enabled: false, payroll_tax_rebate_limit: '0', payroll_cess_enabled: false, payroll_cess_rate: '0',
    payroll_esi_enabled: false, payroll_esi_employee_rate: '0', payroll_esi_employer_rate: '0', payroll_esi_salary_cap: '0',
  },
  DE: {
    payroll_country: 'DE', payroll_currency: 'EUR', payroll_currency_symbol: '€',
    payroll_work_hours_per_day: '8', payroll_work_days_per_week: '5', payroll_overtime_rate: '1.25', payroll_basic_salary_percentage: '100',
    payroll_pf_enabled: true, payroll_pf_employee_rate: '0.196', payroll_pf_employer_rate: '0.196', payroll_pf_salary_cap: '7550', payroll_pf_on_full_salary: false,
    payroll_professional_tax_enabled: false, payroll_professional_tax_slabs: [],
    payroll_tax_regime: 'progressive', payroll_standard_deduction: '11604', payroll_personal_deduction_monthly: '967', payroll_tax_calculation_period: 'annual',
    payroll_tax_brackets: [{ limit: 11604, rate: 0.0 }, { limit: 17005, rate: 0.14 }, { limit: 66760, rate: 0.24 }, { limit: 277825, rate: 0.42 }, { limit: 999999999, rate: 0.45 }],
    payroll_tax_rebate_enabled: false, payroll_tax_rebate_limit: '0', payroll_cess_enabled: true, payroll_cess_rate: '0.055',
    payroll_esi_enabled: false, payroll_esi_employee_rate: '0', payroll_esi_employer_rate: '0', payroll_esi_salary_cap: '0',
  },
  CUSTOM: {
    payroll_country: 'CUSTOM', payroll_currency: '', payroll_currency_symbol: '',
    payroll_work_hours_per_day: '8', payroll_work_days_per_week: '5', payroll_overtime_rate: '1.5', payroll_basic_salary_percentage: '100',
    payroll_pf_enabled: false, payroll_pf_employee_rate: '0', payroll_pf_employer_rate: '0', payroll_pf_salary_cap: '0', payroll_pf_on_full_salary: false,
    payroll_professional_tax_enabled: false, payroll_professional_tax_slabs: [],
    payroll_tax_regime: 'progressive', payroll_standard_deduction: '0', payroll_personal_deduction_monthly: '0', payroll_tax_calculation_period: 'annual',
    payroll_tax_brackets: [{ limit: 999999999, rate: 0.0 }],
    payroll_tax_rebate_enabled: false, payroll_tax_rebate_limit: '0', payroll_cess_enabled: false, payroll_cess_rate: '0',
    payroll_esi_enabled: false, payroll_esi_employee_rate: '0', payroll_esi_employer_rate: '0', payroll_esi_salary_cap: '0',
  },
};

const INDIA_DEFAULTS = COUNTRY_PRESETS.IN;

// ─── Country UI metadata ─────────────────────────────────────────────────────

interface CountryMeta {
  flag: string;
  name: string;
  tag: string;
  pfLabel: string;
  ptLabel: string;
  esiLabel: string;
  cessLabel: string;
  rebateLabel: string;
}

const COUNTRY_META: Record<string, CountryMeta> = {
  IN: {
    flag: '🇮🇳', name: 'India', tag: 'EPF · New Regime TDS · ESI · PT',
    pfLabel: 'Employee Provident Fund (EPF)', ptLabel: 'Professional Tax (PT)',
    esiLabel: 'Employee State Insurance (ESI)', cessLabel: 'Health & Education Cess',
    rebateLabel: 'Section 87A Tax Rebate'
  },
  US: {
    flag: '🇺🇸', name: 'United States', tag: 'Social Security · Medicare · Federal Income Tax',
    pfLabel: 'FICA (Social Security + Medicare)', ptLabel: 'State / Local Tax (optional)',
    esiLabel: 'Healthcare Benefit (optional)', cessLabel: 'Additional Surtax',
    rebateLabel: 'Tax Credit / Rebate'
  },
  GB: {
    flag: '🇬🇧', name: 'United Kingdom', tag: 'National Insurance · PAYE Income Tax',
    pfLabel: 'National Insurance (NI)', ptLabel: 'Regional Tax',
    esiLabel: 'NHS Contribution (optional)', cessLabel: 'Surcharge / Levy',
    rebateLabel: 'Personal Allowance Rebate'
  },
  AE: {
    flag: '🇦🇪', name: 'UAE', tag: 'Zero Tax · GPSSA · Mandatory Gratuity',
    pfLabel: 'GPSSA (UAE nationals)', ptLabel: 'Municipal Tax (optional)',
    esiLabel: 'Health Insurance (optional)', cessLabel: 'Surcharge / Levy',
    rebateLabel: 'Tax Rebate'
  },
  OM: {
    flag: '🇴🇲', name: 'Oman', tag: 'Zero Tax · PASI / SPF · Gratuity',
    pfLabel: 'PASI / Social Protection Fund (Omanis)', ptLabel: 'Municipal Tax (optional)',
    esiLabel: 'Health Insurance (optional)', cessLabel: 'Surcharge / Levy',
    rebateLabel: 'Tax Rebate'
  },
  SG: {
    flag: '🇸🇬', name: 'Singapore', tag: 'CPF · Progressive Income Tax',
    pfLabel: 'Central Provident Fund (CPF)', ptLabel: 'Skills Development Levy',
    esiLabel: 'Medisave (optional)', cessLabel: 'Surtax / Surcharge',
    rebateLabel: 'Personal Relief'
  },
  DE: {
    flag: '🇩🇪', name: 'Germany', tag: 'Sozialversicherung · Einkommensteuer · Soli',
    pfLabel: 'Sozialversicherung (Social Contributions)', ptLabel: 'Kirchensteuer (optional)',
    esiLabel: 'Pflegeversicherung (Care Insurance)', cessLabel: 'Solidaritätszuschlag (Soli)',
    rebateLabel: 'Grundfreibetrag Rebate'
  },
  CUSTOM: {
    flag: '⚙️', name: 'Custom', tag: 'Manually configure all fields below',
    pfLabel: 'Social Insurance / Provident Fund', ptLabel: 'Regional / Municipal Tax',
    esiLabel: 'Health Insurance Scheme', cessLabel: 'Surcharge / Additional Levy',
    rebateLabel: 'Tax Rebate / Credit'
  },
};

const PRESET_ORDER: CountryPreset[] = ['IN', 'US', 'GB', 'AE', 'OM', 'SG', 'DE', 'CUSTOM'];

// ─── Sub-components ──────────────────────────────────────────────────────────

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="relative inline-flex items-center cursor-pointer flex-shrink-0">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} className="sr-only peer" />
      <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-brand-primary" />
    </label>
  );
}

function FieldRow({ label, icon: Icon, hint, children }: { label: string; icon?: React.ElementType; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium text-slate-700 flex items-center gap-1.5">
        {Icon && <Icon size={15} className="text-slate-400" />}
        {label}
        {hint}
      </label>
      {children}
    </div>
  );
}

function InputField({ value, onChange, type = 'text', placeholder = '', ...rest }: {
  value: string; onChange: (v: string) => void; type?: string; placeholder?: string;
  [key: string]: any;
}) {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      onChange={e => onChange(e.target.value)}
      className="w-full h-10 px-3 border border-slate-200 rounded-lg focus:outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/30 transition-all text-sm bg-white"
      {...rest}
    />
  );
}

/** Ticking clock that shows current time in a given IANA timezone. */
function LiveTZClock({ tz }: { tz: string }) {
  const [time, setTime] = React.useState(() => nowTimeStr(tz));
  React.useEffect(() => {
    setTime(nowTimeStr(tz));
    const id = setInterval(() => setTime(nowTimeStr(tz)), 1000);
    return () => clearInterval(id);
  }, [tz]);
  return (
    <span className="text-xl sm:text-2xl font-semibold text-slate-800 tabular-nums tracking-wide">{time}</span>
  );
}

function SectionCard({ title, icon: Icon, badge, children, collapsible = false }: {
  title: string; icon: React.ElementType; badge?: string; children: React.ReactNode; collapsible?: boolean;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="surface-panel overflow-hidden">
      <button
        type="button"
        onClick={() => collapsible && setOpen(o => !o)}
        className={`w-full flex items-center justify-between px-4 py-3 border-b border-slate-100 ${collapsible ? 'cursor-pointer hover:bg-slate-50 transition-colors' : 'cursor-default'}`}
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-brand-primary/10 rounded-lg flex items-center justify-center">
            <Icon size={16} className="text-brand-primary" />
          </div>
          <div className="text-left">
            <h3 className="text-sm sm:text-base font-semibold text-slate-800">{title}</h3>
            {badge && <span className="text-xs text-slate-500">{badge}</span>}
          </div>
        </div>
        {collapsible && (
          <span className="text-xs text-slate-400">{open ? '▲' : '▼'}</span>
        )}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="p-4 sm:p-5 space-y-4">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Live preview of the company logo and how it appears as a browser-tab favicon.
 * Purely presentational — renders the current SVG/URL logo (SVG takes
 * precedence, matching the backend rule). The actual favicon is rasterized
 * server-side on save; this just shows what it will look like.
 */
function BrandingPreview({ companyName, logoSvg, logoUrl }: {
  companyName: string; logoSvg: string; logoUrl: string;
}) {
  const hasSvg = !!logoSvg.trim();
  const hasLogo = hasSvg || !!logoUrl.trim();
  const title = companyName.trim() || 'Human Resources Management System';

  const LogoMark = ({ size }: { size: number }) => {
    if (hasSvg) {
      return (
        <span
          className="inline-flex items-center justify-center [&>svg]:w-full [&>svg]:h-full"
          style={{ width: size, height: size }}
          dangerouslySetInnerHTML={{ __html: logoSvg }}
        />
      );
    }
    if (logoUrl.trim()) {
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={logoUrl} alt="logo" width={size} height={size} className="object-contain" style={{ width: size, height: size }} />;
    }
    return (
      <span className="inline-flex items-center justify-center rounded bg-slate-200 text-slate-400" style={{ width: size, height: size }}>
        <Building2 size={size * 0.6} />
      </span>
    );
  };

  return (
    <div className="flex flex-col gap-3 rounded-xl border-2 border-dashed border-slate-200 bg-slate-50 p-4">
      <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
        <Info size={14} className="text-brand-primary" /> Preview
      </div>
      <div className="flex flex-wrap items-end gap-6">
        {/* Logo preview */}
        <div className="flex flex-col items-center gap-2">
          <div className="flex h-20 w-20 items-center justify-center rounded-xl border border-slate-200 bg-white shadow-sm">
            <LogoMark size={56} />
          </div>
          <span className="text-[11px] text-slate-400">Logo</span>
        </div>

        {/* Browser-tab preview */}
        <div className="flex flex-col items-center gap-2">
          <div className="flex items-end">
            <div className="flex max-w-[220px] items-center gap-2 rounded-t-lg border border-b-0 border-slate-200 bg-white px-3 py-2 shadow-sm">
              <LogoMark size={16} />
              <span className="truncate text-xs text-slate-600">{title}</span>
              <span className="ml-1 text-slate-300">×</span>
            </div>
          </div>
          <div className="-mt-2 h-2 w-[240px] rounded-b bg-white border border-slate-200" />
          <span className="text-[11px] text-slate-400">Browser tab</span>
        </div>
      </div>
      {!hasLogo && (
        <p className="text-[11px] text-slate-400">Add an SVG or logo URL above to generate the favicon on save.</p>
      )}
    </div>
  );
}

/**
 * Theme & Appearance picker — color preset cards + font selector.
 * Selecting either applies live company-wide via the branding store; the
 * choice is persisted to system-settings on Save.
 */

/** Small hover tooltip that uses position:fixed to escape overflow:hidden containers. */
function InfoHint({ text, example }: { text: string; example?: string }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);

  const handleEnter = () => {
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({ x: r.left + r.width / 2, y: r.top });
  };

  return (
    <span ref={ref} className="relative inline-flex items-center" onMouseEnter={handleEnter} onMouseLeave={() => setPos(null)}>
      <Info size={14} className="text-slate-400 hover:text-brand-primary cursor-help" />
      {pos && (
        <span
          style={{ position: 'fixed', left: pos.x, top: pos.y - 8, transform: 'translateX(-50%) translateY(-100%)' }}
          className="pointer-events-none z-[9999] w-72 rounded-lg bg-slate-900 px-3 py-2 text-xs font-normal leading-relaxed text-white shadow-xl"
        >
          {text}
          {example && (
            <span className="mt-2 block border-t border-slate-700 pt-2 text-slate-300">
              <span className="font-semibold text-amber-400">Example:</span> {example}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

const CUSTOM_PRESET_ID = 'custom';
const CUSTOM_FONT_ID = 'custom';

/** Per-color label, short description, and how-to tooltip. */
const COLOR_META: Record<string, { label: string; desc: string; hint: string }> = {
  brandPrimary: {
    label: 'Primary',
    desc: 'Main brand color',
    hint: 'The core brand color — used for primary buttons, active navigation, links and key highlights. Tip: pick your strongest brand color here.',
  },
  brandPrimaryDark: {
    label: 'Primary · Dark',
    desc: 'Hover / pressed',
    hint: 'Shown when a user hovers or presses a primary element. Choose a shade roughly 10–15% darker than Primary.',
  },
  brandPrimaryLight: {
    label: 'Primary · Light',
    desc: 'Soft background',
    hint: 'A soft tint placed behind primary elements (selected rows, badges, focus rings). Choose a very light version of Primary.',
  },
  brandAccent: {
    label: 'Accent',
    desc: 'Secondary highlight',
    hint: 'Secondary call-to-action color and the second series color in charts. Pick a color that contrasts nicely with Primary.',
  },
  brandAccentDark: {
    label: 'Accent · Dark',
    desc: 'Accent hover',
    hint: 'Hover / pressed state of accent elements. Choose a shade darker than Accent.',
  },
};

function ThemeAppearance({
  presetId,
  fontId,
  customColorsJson,
  customFontFamily,
  customFontUrl,
  onSelectPreset,
  onSelectCustomColors,
  onSelectFont,
  onChangeCustomColor,
  onChangeCustomFont,
}: {
  presetId: string;
  fontId: string;
  customColorsJson: string;
  customFontFamily: string;
  customFontUrl: string;
  onSelectPreset: (id: string) => void;
  onSelectCustomColors: (json: string) => void;
  onSelectFont: (id: string) => void;
  onChangeCustomColor: (json: string) => void;
  onChangeCustomFont: (family: string, url: string) => void;
}) {
  const customActive = presetId === CUSTOM_PRESET_ID;
  const customFontActive = fontId === CUSTOM_FONT_ID;

  // Inject all font stylesheets once so each option renders in its own font.
  useEffect(() => {
    THEME_FONTS.forEach((f) => {
      const id = `font-preview-${f.id}`;
      if (document.getElementById(id)) return;
      const link = document.createElement('link');
      link.id = id;
      link.rel = 'stylesheet';
      link.href = f.googleFontsUrl;
      document.head.appendChild(link);
    });
  }, []);

  // Parse the stored custom colors (fall back to the default preset's brand colors).
  const customColors = useMemo(() => {
    const base = getPreset('default').config.colors;
    const seed: Record<string, string> = {};
    CUSTOM_COLOR_KEYS.forEach((k) => (seed[k] = base[k]));
    try {
      const parsed = customColorsJson ? JSON.parse(customColorsJson) : {};
      return { ...seed, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
    } catch {
      return seed;
    }
  }, [customColorsJson]);

  // Live-load the custom Google font (debounced) so the preview renders.
  const previewFamily = customFontActive ? customFontFamily.trim() : '';
  useEffect(() => {
    if (!previewFamily) return;
    const t = setTimeout(() => {
      const link = (document.getElementById('custom-font-preview') as HTMLLinkElement) ||
        Object.assign(document.createElement('link'), { id: 'custom-font-preview', rel: 'stylesheet' });
      const name = previewFamily.replace(/\s+/g, '+');
      link.href = customFontUrl.trim() ||
        `https://fonts.googleapis.com/css2?family=${name}:wght@300;400;500;600;700;800&display=swap`;
      if (!link.parentNode) document.head.appendChild(link);
    }, 400);
    return () => clearTimeout(t);
  }, [previewFamily, customFontUrl]);

  const seedCustomColors = () => {
    const base = getPreset(customActive ? 'default' : presetId).config.colors;
    const seed: Record<string, string> = {};
    CUSTOM_COLOR_KEYS.forEach((k) => (seed[k] = base[k]));
    onSelectCustomColors(JSON.stringify(seed));
  };

  const setColor = (key: string, value: string) => {
    onChangeCustomColor(JSON.stringify({ ...customColors, [key]: value }));
  };

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      {/* ── Color theme ── */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-1.5">
          <p className="text-xs font-medium text-slate-700">Color Theme</p>
          <span className="text-xs text-slate-400">— pick a ready-made palette or build your own</span>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          {THEME_PRESETS.map((p) => {
            const selected = p.id === presetId;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => onSelectPreset(p.id)}
                className={`flex flex-col gap-3 rounded-xl border-2 p-4 text-left transition-all hover:shadow-md ${selected
                    ? 'border-brand-primary ring-2 ring-brand-primary/20'
                    : 'border-slate-200 hover:border-slate-300'
                  }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-text-heading">{p.name}</span>
                  {selected && <CheckCircle2 size={16} className="text-brand-primary" />}
                </div>
                <div className="flex gap-1.5">
                  {[p.swatch.primary, p.swatch.accent, p.swatch.sidebar, p.swatch.surface].map((color, i) => (
                    <span
                      key={i}
                      className="h-7 w-7 rounded-lg border border-black/5 shadow-sm"
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </div>
              </button>
            );
          })}

          {/* Custom palette card */}
          <button
            type="button"
            onClick={seedCustomColors}
            className={`flex flex-col gap-3 rounded-xl border-2 border-dashed p-4 text-left transition-all hover:shadow-md ${customActive
                ? 'border-brand-primary ring-2 ring-brand-primary/20'
                : 'border-slate-300 hover:border-slate-400'
              }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-text-heading">Custom</span>
              {customActive ? <CheckCircle2 size={16} className="text-brand-primary" /> : <Plus size={16} className="text-slate-400" />}
            </div>
            <div className="flex gap-1.5">
              {CUSTOM_COLOR_KEYS.slice(0, 4).map((k, i) => (
                <span
                  key={i}
                  className="h-7 w-7 rounded-lg border border-black/5 shadow-sm"
                  style={{ backgroundColor: customColors[k] }}
                />
              ))}
            </div>
          </button>
        </div>

        {/* Custom color editor */}
        {customActive && (
          <div className="mt-1 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-center gap-1.5 mb-3">
              <p className="text-sm font-semibold text-text-heading">Brand Colors</p>
              <InfoHint text="Click a swatch to open the color picker, or type a HEX code (e.g. #00358F). Changes preview live across the app and are saved when you press Save." />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {CUSTOM_COLOR_KEYS.map((key) => {
                const meta = COLOR_META[key];
                const val = customColors[key] || '#000000';
                return (
                  <div key={key} className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-2.5">
                    <input
                      type="color"
                      value={val}
                      onChange={(e) => setColor(key, e.target.value)}
                      className="h-9 w-9 flex-shrink-0 cursor-pointer rounded-md border border-slate-200 bg-white p-0.5"
                      aria-label={meta.label}
                    />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="flex items-center gap-1 text-xs font-semibold text-slate-700">
                        {meta.label}
                        <InfoHint text={meta.hint} />
                      </span>
                      <span className="text-[11px] text-slate-400">{meta.desc}</span>
                    </div>
                    <input
                      type="text"
                      value={val}
                      onChange={(e) => setColor(key, e.target.value)}
                      spellCheck={false}
                      className="w-20 rounded-md border border-slate-200 px-2 py-1 text-xs font-mono uppercase text-slate-600 focus:border-brand-primary focus:outline-none"
                    />
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* ── Font ── */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-1.5">
          <p className="text-xs font-medium text-slate-700">Font</p>
          <span className="text-xs text-slate-400">— choose a bundled font or load any Google Font</span>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          {THEME_FONTS.map((f) => {
            const selected = f.id === fontId;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => onSelectFont(f.id)}
                style={{ fontFamily: f.fontStack }}
                className={`flex flex-col gap-1 rounded-xl border-2 px-4 py-3 text-left transition-all hover:shadow-md ${selected
                    ? 'border-brand-primary ring-2 ring-brand-primary/20'
                    : 'border-slate-200 hover:border-slate-300'
                  }`}
              >
                <span className="text-base font-semibold text-text-heading">{f.label}</span>
                <span className="text-xs text-slate-400">Aa Bb Cc 123</span>
              </button>
            );
          })}

          {/* Custom font card */}
          <button
            type="button"
            onClick={() => onSelectFont(CUSTOM_FONT_ID)}
            className={`flex flex-col gap-1 rounded-xl border-2 border-dashed px-4 py-3 text-left transition-all hover:shadow-md ${customFontActive
                ? 'border-brand-primary ring-2 ring-brand-primary/20'
                : 'border-slate-300 hover:border-slate-400'
              }`}
            style={previewFamily ? { fontFamily: `"${previewFamily}", sans-serif` } : undefined}
          >
            <span className="text-base font-semibold text-text-heading">Custom</span>
            <span className="text-xs text-slate-400">Google Fonts</span>
          </button>
        </div>

        {/* Custom font editor */}
        {customFontActive && (
          <div className="mt-1 rounded-xl border border-slate-200 bg-slate-50 p-4 flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-700">
                Google Font name
                <InfoHint text="Go to fonts.google.com, open any font, and copy its name exactly (e.g. 'Roboto Slab', 'Space Grotesk'). We build the import URL and load it automatically — no code needed." />
              </span>
              <input
                type="text"
                value={customFontFamily}
                onChange={(e) => onChangeCustomFont(e.target.value, customFontUrl)}
                placeholder="e.g. Roboto Slab"
                spellCheck={false}
                className="w-full rounded-lg border-2 border-slate-200 px-3 py-2 text-sm focus:border-brand-primary focus:outline-none"
              />
              <span className="text-[11px] text-slate-400">Type the family name exactly as shown on Google Fonts. Loaded live in the preview below.</span>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-700">
                Stylesheet URL <span className="font-normal text-slate-400">(optional)</span>
                <InfoHint text="Advanced: paste a full Google Fonts <link> URL (https://fonts.googleapis.com/css2?family=...) to control exact weights/styles. Leave empty to auto-generate from the name above." />
              </span>
              <input
                type="text"
                value={customFontUrl}
                onChange={(e) => onChangeCustomFont(customFontFamily, e.target.value)}
                placeholder="https://fonts.googleapis.com/css2?family=..."
                spellCheck={false}
                className="w-full rounded-lg border-2 border-slate-200 px-3 py-2 text-xs font-mono focus:border-brand-primary focus:outline-none"
              />
            </div>

            {previewFamily && (
              <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
                <p className="text-[11px] uppercase tracking-wide text-slate-400 mb-1">Preview</p>
                <p className="text-xl sm:text-2xl text-text-heading" style={{ fontFamily: `"${previewFamily}", sans-serif` }}>
                  {previewFamily} — The quick brown fox 0123
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const { user, logout, loadUser } = useAuthStore();

  // The one heading for this route, rendered by TopHeader.
  usePageHeader('Settings', 'Customize the system according to your needs');

  // ── Payroll extension switches ────────────────────────────────────────
  //
  // Held apart from `payroll` deliberately. Those keys are hand-enumerated in
  // five places each; these are declared once in PAYROLL_FEATURE_SWITCHES and
  // written as a flat patch, because POST /system-settings upserts the keys it
  // is given and leaves everything else alone. That is what keeps adding the
  // next switch a one-line change instead of a five-file one.
  const [featureFlags, setFeatureFlags] = useState<Record<string, boolean>>({});

  const setFeatureFlag = (key: string, next: boolean) => {
    setFeatureFlags((prev) => ({ ...prev, [key]: next }));
  };

  const [activeTab, setActiveTab] = useState('general');

  // Developer mode: whether the operator-only tabs and sections are unlocked.
  const { elevated: devElevated } = useDevMode();

  // An elevation can lapse while a developer tab is open. Bounce back to a tab
  // the admin is allowed to see rather than leaving a pane that 403s on every
  // request it makes.
  useEffect(() => {
    if (!devElevated && DEVELOPER_TAB_IDS.includes(activeTab)) {
      setActiveTab('general');
    }
  }, [devElevated, activeTab]);

  // Danger Zone: reset-to-baseline (type-to-confirm)
  const [showResetModal, setShowResetModal] = useState(false);
  const [resetPhrase, setResetPhrase] = useState('');
  const [resetting, setResetting] = useState(false);

  const handleResetDatabase = async () => {
    setResetting(true);
    const t = toast.loading('Resetting database to baseline…');
    try {
      await systemSettingsService.resetToBaseline();
      toast.success('Database reset to baseline. Signing you out…', { id: t });
      setShowResetModal(false);
      // Base account IDs changed — the current session is now stale. Sign out
      // and hard-reload to /login so all cached state is discarded.
      setTimeout(async () => {
        try { await logout(); } catch { /* ignore */ }
        window.location.href = '/login';
      }, 1200);
    } catch (e: any) {
      toast.error(e?.response?.data?.message || e?.message || 'Reset failed', { id: t });
      setResetting(false);
    }
  };

  // Sample/demo data seeding with live streamed progress
  const [seedPhase, setSeedPhase] = useState<'idle' | 'confirm' | 'running' | 'done' | 'error'>('idle');
  const [seedLogs, setSeedLogs] = useState<{ message: string; step?: number; total?: number }[]>([]);
  const [seedSummary, setSeedSummary] = useState<Record<string, number> | null>(null);
  const [seedError, setSeedError] = useState('');
  const seedLogRef = useRef<HTMLDivElement>(null);
  // Keep the completed-steps list pinned to the newest entry.
  useEffect(() => {
    const el = seedLogRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [seedLogs]);

  const startSeeding = async () => {
    setSeedLogs([]); setSeedSummary(null); setSeedError(''); setSeedPhase('running');
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;
      const branchId = useBranchStore.getState().selectedBranchId;
      const base = (axiosInstance.defaults.baseURL || '').replace(/\/$/, '');
      // This request bypasses the axios instance (it streams NDJSON), so the
      // interceptor never runs and every header has to be attached by hand —
      // including the developer-mode token the seed route now requires.
      const devToken = currentDevToken();
      const res = await fetch(`${base}/sample-data/seed`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(branchId ? { 'X-Branch-Id': branchId } : {}),
          ...(devToken ? { 'X-Dev-Token': devToken } : {}),
        },
        body: JSON.stringify({ confirm: 'SEED' }),
      });
      if (!res.ok || !res.body) {
        let msg = `Request failed (${res.status})`;
        try { const j = await res.json(); msg = j?.message || msg; } catch { /* ignore */ }
        throw new Error(msg);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let evt: any;
          try { evt = JSON.parse(line); } catch { continue; }
          if (evt.type === 'done') {
            setSeedSummary(evt.data?.counts || null);
            setSeedPhase('done');
          } else if (evt.type === 'error') {
            setSeedError(evt.message || 'Seeding failed');
            setSeedPhase('error');
          } else if (evt.type === 'step') {
            setSeedLogs(prev => [...prev, { message: evt.message, step: evt.step, total: evt.total }]);
          }
        }
      }
    } catch (e: any) {
      setSeedError(e?.message || 'Seeding failed');
      setSeedPhase('error');
    }
  };

  const [settings, setSettings] = useState({
    notifications: { email: true, push: true, leaveApproval: true, overtimeApproval: true, payroll: false },
    language: 'en',
    theme: 'light',
    dashboardVersion: 'v2' as DashboardVersion,
  });

  // Dashboard layout is an org-wide setting persisted in the backend
  // (system_settings.dashboard_layout) and served via the branding store.
  const orgDashboardLayout = useBrandingStore(s => s.branding.dashboard_layout);
  useEffect(() => {
    setSettings(s => ({ ...s, dashboardVersion: orgDashboardLayout }));
  }, [orgDashboardLayout]);

  // Company timezone set by the admin — the default an employee inherits when
  // they don't pick a personal one.
  const companyTz = useBrandingStore(s => s.branding.system_timezone) || 'Asia/Kolkata';
  // Employee's personal display timezone. '' = inherit the company timezone.
  const [personalTz, setPersonalTz] = useState<string>('');
  useEffect(() => {
    setPersonalTz(user?.timezone ?? (user as any)?.employee?.timezone ?? '');
  }, [user]);

  // Employee's personal date-display format. Defaults to DD/MM/YYYY.
  const [personalDateFormat, setPersonalDateFormat] = useState<string>('DD/MM/YYYY');
  useEffect(() => {
    setPersonalDateFormat(user?.dateFormat ?? (user as any)?.employee?.dateFormat ?? 'DD/MM/YYYY');
  }, [user]);

  const handleDashboardVersionChange = async (version: DashboardVersion) => {
    if (user?.role !== 'ADMIN') {
      toast.error('Only an admin can change the organisation dashboard layout.');
      return;
    }
    const prev = settings.dashboardVersion;
    setSettings(s => ({ ...s, dashboardVersion: version }));
    useBrandingStore.getState().updateBrandingState({ dashboard_layout: version });
    try {
      await systemSettingsService.update({ dashboard_layout: version });
      toast.success(`Dashboard layout set to ${version === 'v1' ? 'Classic' : 'Modern'} — reload /dashboard to see it.`);
    } catch (err: any) {
      setSettings(s => ({ ...s, dashboardVersion: prev }));
      useBrandingStore.getState().updateBrandingState({ dashboard_layout: prev });
      toast.error(err?.response?.data?.message || 'Failed to save dashboard layout.');
    }
  };

  const [overtimeSettings, setOvertimeSettings] = useState({
    overtime_enabled: true,
    overtime_late_threshold: '22:00',
    overtime_food_allowance_enabled: true,
    overtime_food_allowance_threshold: '22:00',
    overtime_food_allowance_amount: '150',
    overtime_regular_rate: '1.5',
    overtime_late_rate: '1.5',
    overtime_double_ot_enabled: true,
    overtime_double_rate: '2.0',
    overtime_sunday_regular_rate: '2.0',
    overtime_sunday_late_rate: '2.0',
    overtime_sunday_late_threshold: '22:00',
    overtime_holiday_regular_rate: '2.0',
    overtime_holiday_late_rate: '2.0',
    overtime_holiday_late_threshold: '22:00',
    overtime_shift_end_time: '17:00',
    overtime_double_food_allowance_any_time: false,
    overtime_double_ot_allow_anytime: true,
    overtime_max_hours_per_day: '4',
    overtime_max_hours_per_month: '30',
    overtime_max_hours_per_year: '200',
    overtime_require_manager_approval: true,
    overtime_allow_employee_submit: true,
    overtime_require_reason: true,
  });


  const [systemSettings, setSystemSettings] = useState({
    allow_multiple_checkin: false,
    attendance_face_only: false,
    face_recognition_enabled: true,
    attendance_daily_report_enabled: true,
    attendance_daily_report_time: '17:30',
    attendance_day_end_time: '23:59',
    strict_attendance_mode: false,
    monthly_attendance_request_limit: '3',
    leave_approval_hierarchy_enabled: false,
    allow_hard_delete_terminated: false,
    mail_enabled: false,
    mail_host: '',
    mail_port: '',
    mail_user: '',
    mail_password: '',
    mail_from: '',
    mail_from_name: '',
    mail_bcc: '',
    company_name: '',
    company_subtitle: '',
    company_logo_url: '',
    company_logo_svg: '',
    company_name_image_url: '',
    company_shortname: '',
    theme_preset: 'default',
    theme_font: 'montserrat',
    theme_custom_colors: '',
    theme_custom_font_family: '',
    theme_custom_font_url: '',
    calendar_weekly_holidays: '0',
    visa_expiry_alert_days: '30',
    shift_reminder_prior_mins: '5',
    shift_reminder_post_mins: '5',
    office_start_time: '08:30',
    office_end_time: '17:30',
    lunch_break_start: '13:00',
    lunch_break_duration_minutes: '60',
    geofencing_enabled: false,
    office_latitude: '',
    office_longitude: '',
    geofencing_radius_meters: '100',
    system_timezone: 'Asia/Kolkata',
    dept_manager_min_tenure_months: '6',
    dept_manager_transition_days: '14',
    task_assignment_list_mode: 'all',
    // Blank = unlimited backdating. See start-date-policy.util.ts on the server.
    employee_start_date_max_past_days: '',
    employee_start_date_max_future_days: '180',
    employee_start_date_floor: '1970-01-01',
    // Ships OFF. Kept as the string the settings API speaks in — every value
    // in this bag is a string, because POST /system-settings takes a
    // key -> string map.
    document_engine_enabled: 'false',
  });

  const [payroll, setPayroll] = useState<PayrollSettings>({
    ...INDIA_DEFAULTS,
    payroll_daily_wage_statutory_deductions: true,
    payroll_daily_wage_pay_leave: false,
    payroll_daily_wage_pay_holidays: false,
  });
  const [customLabels, setCustomLabels] = useState<PayrollLabels>(EMPTY_LABELS);
  const [saving, setSaving] = useState(false);
  /** Did GET /system-settings include the developer-owned mail_* keys? Governs
   *  whether Save is allowed to write them back. See handleSave. */
  const [mailKeysVisible, setMailKeysVisible] = useState(false);
  const [applyingPreset, setApplyingPreset] = useState(false);
  const [presetApplied, setPresetApplied] = useState<string | null>(null);

  // Memoize so the <option> list is stable — prevents the browser from
  // visually snapping back to the first option after every render.
  const groupedTimezones = useMemo(() => getGroupedTimezones(), []);

  // Security / Password change state
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isChangingPassword, setIsChangingPassword] = useState(false);

  // ── Parse helpers ─────────────────────────────────────────────────────────

  const parsePayrollSettings = useCallback((list: { key: string; value: string }[]) => {
    const find = (key: string) => list.find(s => s.key === key)?.value ?? '';
    const tryParseJSON = <T,>(raw: string, fallback: T): T => {
      try { return JSON.parse(raw) as T; } catch { return fallback; }
    };

    setPayroll({
      payroll_country: find('payroll_country') || 'IN',
      payroll_currency: find('payroll_currency') || 'INR',
      payroll_currency_symbol: find('payroll_currency_symbol') || '₹',
      payroll_currency_display: find('payroll_currency_display') || 'symbol',
      payroll_work_hours_per_day: find('payroll_work_hours_per_day') || '8',
      payroll_work_days_per_week: find('payroll_work_days_per_week') || '5',
      payroll_overtime_rate: find('payroll_overtime_rate') || '1.5',
      payroll_basic_salary_percentage: find('payroll_basic_salary_percentage') || '40',

      payroll_pf_enabled: find('payroll_pf_enabled') !== 'false',
      payroll_pf_employee_rate: find('payroll_pf_employee_rate') || '0.12',
      payroll_pf_employer_rate: find('payroll_pf_employer_rate') || '0.12',
      payroll_pf_salary_cap: find('payroll_pf_salary_cap') || '15000',
      payroll_pf_on_full_salary: find('payroll_pf_on_full_salary') === 'true',

      payroll_professional_tax_enabled: find('payroll_professional_tax_enabled') !== 'false',
      payroll_professional_tax_slabs: tryParseJSON<PtSlab[]>(find('payroll_professional_tax_slabs'), INDIA_DEFAULTS.payroll_professional_tax_slabs),

      payroll_tax_regime: find('payroll_tax_regime') || 'new',
      payroll_standard_deduction: find('payroll_standard_deduction') || '75000',
      payroll_personal_deduction_monthly: find('payroll_personal_deduction_monthly') || '6250',
      payroll_tax_calculation_period: find('payroll_tax_calculation_period') || 'annual',
      payroll_tax_brackets: tryParseJSON<TaxBracket[]>(find('payroll_tax_brackets'), INDIA_DEFAULTS.payroll_tax_brackets),

      payroll_tax_rebate_enabled: find('payroll_tax_rebate_enabled') !== 'false',
      payroll_tax_rebate_limit: find('payroll_tax_rebate_limit') || '700000',
      payroll_cess_enabled: find('payroll_cess_enabled') !== 'false',
      payroll_cess_rate: find('payroll_cess_rate') || '0.04',

      payroll_esi_enabled: find('payroll_esi_enabled') !== 'false',
      payroll_esi_employee_rate: find('payroll_esi_employee_rate') || '0.0075',
      payroll_esi_employer_rate: find('payroll_esi_employer_rate') || '0.0325',
      payroll_esi_salary_cap: find('payroll_esi_salary_cap') || '21000',


      payroll_daily_wage_statutory_deductions:
        find('payroll_daily_wage_statutory_deductions') !== 'false',
      // These two default to FALSE, hence === 'true' rather than !== 'false'.
      payroll_daily_wage_pay_leave:
        find('payroll_daily_wage_pay_leave') === 'true',
      payroll_daily_wage_pay_holidays:
        find('payroll_daily_wage_pay_holidays') === 'true',
    });

    // Parse custom labels — empty string means "use country-meta default"
    setCustomLabels({
      payroll_label_general: find('payroll_label_general'),
      payroll_label_pf: find('payroll_label_pf'),
      payroll_label_pf_employee_rate: find('payroll_label_pf_employee_rate'),
      payroll_label_pf_employer_rate: find('payroll_label_pf_employer_rate'),
      payroll_label_pf_cap: find('payroll_label_pf_cap'),
      payroll_label_esi: find('payroll_label_esi'),
      payroll_label_esi_employee_rate: find('payroll_label_esi_employee_rate'),
      payroll_label_esi_employer_rate: find('payroll_label_esi_employer_rate'),
      payroll_label_esi_cap: find('payroll_label_esi_cap'),
      payroll_label_pt: find('payroll_label_pt'),
      payroll_label_income_tax: find('payroll_label_income_tax'),
      payroll_label_cess: find('payroll_label_cess'),
      payroll_label_rebate: find('payroll_label_rebate'),
    });
  }, []);

  const parseOvertimeSettings = useCallback((list: { key: string; value: string }[]) => {
    const find = (key: string) => list.find(s => s.key === key)?.value ?? '';
    setOvertimeSettings({
      overtime_enabled: find('overtime_enabled') !== 'false',
      overtime_late_threshold: find('overtime_late_threshold') || '22:00',
      overtime_food_allowance_enabled: find('overtime_food_allowance_enabled') !== 'false',
      overtime_food_allowance_threshold: find('overtime_food_allowance_threshold') || find('overtime_late_threshold') || '22:00',
      overtime_food_allowance_amount: find('overtime_food_allowance_amount') || '150',
      overtime_regular_rate: find('overtime_regular_rate') || '1.5',
      overtime_late_rate: find('overtime_late_rate') || '1.5',
      overtime_double_ot_enabled: find('overtime_double_ot_enabled') !== 'false',
      overtime_double_rate: find('overtime_double_rate') || '2.0',
      overtime_sunday_regular_rate: find('overtime_sunday_regular_rate') || find('overtime_double_rate') || '2.0',
      overtime_sunday_late_rate: find('overtime_sunday_late_rate') || find('overtime_double_rate') || '2.0',
      overtime_sunday_late_threshold: find('overtime_sunday_late_threshold') || find('overtime_late_threshold') || '22:00',
      overtime_holiday_regular_rate: find('overtime_holiday_regular_rate') || find('overtime_double_rate') || '2.0',
      overtime_holiday_late_rate: find('overtime_holiday_late_rate') || find('overtime_double_rate') || '2.0',
      overtime_holiday_late_threshold: find('overtime_holiday_late_threshold') || find('overtime_late_threshold') || '22:00',
      overtime_shift_end_time: find('overtime_shift_end_time') || '17:00',
      overtime_double_food_allowance_any_time: find('overtime_double_food_allowance_any_time') === 'true',
      overtime_double_ot_allow_anytime: find('overtime_double_ot_allow_anytime') !== 'false',
      overtime_max_hours_per_day: find('overtime_max_hours_per_day') || '4',
      overtime_max_hours_per_month: find('overtime_max_hours_per_month') || '30',
      overtime_max_hours_per_year: find('overtime_max_hours_per_year') || '200',
      overtime_require_manager_approval: find('overtime_require_manager_approval') !== 'false',
      overtime_allow_employee_submit: find('overtime_allow_employee_submit') !== 'false',
      overtime_require_reason: find('overtime_require_reason') !== 'false',
    });
  }, []);

  // ── Fetch ─────────────────────────────────────────────────────────────────

  // Refetch on elevation change as well: the mail_* keys are absent from the
  // unelevated response, so after stepping up mid-session the SMTP form would
  // otherwise stay blank over real stored config.
  useEffect(() => {
    if (user?.role === 'ADMIN') fetchSystemSettings();
  }, [user, devElevated]);

  const fetchSystemSettings = async () => {
    try {
      const res: any = await systemSettingsService.getAll();
      if (res?.success) {
        const list: { key: string; value: string }[] = res.data;
        const findVal = (key: string) => list.find(s => s.key === key)?.value || '';

        // Read every declared extension switch out of the same list. `=== 'true'`
        // and never `!== 'false'`: a key this build has not heard of must read
        // OFF, not ON.
        const flagKeys = PAYROLL_FEATURE_SWITCHES.flatMap((f) => [
          f.key,
          ...(f.children ?? []).map((c) => c.key),
        ]);
        setFeatureFlags(
          Object.fromEntries(
            flagKeys.map((k) => [
              k,
              // Strict reconciliation is a failure-mode rather than a feature —
              // refusing a payroll whose lines do not add up — so it defaults ON
              // and an absent row must not read as "do not check".
              k === 'payroll_item_lines_strict_reconciliation'
                ? findVal(k) !== 'false'
                : findVal(k) === 'true',
            ]),
          ),
        );
        // getSettingsList() is a static registry: it always emits every mail_*
        // row, falling back to a default when there is no DB row. So their
        // ABSENCE here means the developer-key filter stripped them, never that
        // SMTP is merely unconfigured — which is what makes this safe to use as
        // the write gate, including on a fresh install.
        setMailKeysVisible(list.some(s => s.key.startsWith('mail_')));
        setSystemSettings({
          allow_multiple_checkin: findVal('allow_multiple_checkin') === 'true',
          attendance_face_only: findVal('attendance_face_only') === 'true',
          face_recognition_enabled: findVal('face_recognition_enabled') !== 'false',
          attendance_daily_report_enabled: findVal('attendance_daily_report_enabled') !== 'false',
          attendance_daily_report_time: findVal('attendance_daily_report_time') || findVal('office_end_time') || '17:30',
          attendance_day_end_time: findVal('attendance_day_end_time') || '23:59',
          strict_attendance_mode: findVal('strict_attendance_mode') === 'true',
          monthly_attendance_request_limit: findVal('monthly_attendance_request_limit') || '3',
          leave_approval_hierarchy_enabled: findVal('leave_approval_hierarchy_enabled') === 'true',
          allow_hard_delete_terminated: findVal('allow_hard_delete_terminated') === 'true',
          mail_enabled: findVal('mail_enabled') === 'true',
          mail_host: findVal('mail_host'),
          mail_port: findVal('mail_port'),
          mail_user: findVal('mail_user'),
          mail_password: findVal('mail_password'),
          mail_from: findVal('mail_from'),
          mail_from_name: findVal('mail_from_name'),
          mail_bcc: findVal('mail_bcc'),
          company_name: findVal('company_name') || 'The Company',
          company_subtitle: findVal('company_subtitle') || 'TRS ADMIN',
          company_logo_url: findVal('company_logo_url'),
          company_logo_svg: findVal('company_logo_svg'),
          company_name_image_url: findVal('company_name_image_url'),
          company_shortname: findVal('company_shortname') || 'TRS',
          theme_preset: findVal('theme_preset') || 'default',
          theme_font: findVal('theme_font') || 'montserrat',
          theme_custom_colors: findVal('theme_custom_colors') || '',
          theme_custom_font_family: findVal('theme_custom_font_family') || '',
          theme_custom_font_url: findVal('theme_custom_font_url') || '',
          calendar_weekly_holidays: findVal('calendar_weekly_holidays') || '0',
          visa_expiry_alert_days: findVal('visa_expiry_alert_days') || '30',
          shift_reminder_prior_mins: findVal('shift_reminder_prior_mins') || '5',
          shift_reminder_post_mins: findVal('shift_reminder_post_mins') || '5',
          office_start_time: findVal('office_start_time') || '08:30',
          office_end_time: findVal('office_end_time') || '17:30',
          lunch_break_start: findVal('lunch_break_start') || '13:00',
          lunch_break_duration_minutes: findVal('lunch_break_duration_minutes') || '60',
          geofencing_enabled: findVal('geofencing_enabled') === 'true',
          office_latitude: findVal('office_latitude') || '',
          office_longitude: findVal('office_longitude') || '',
          geofencing_radius_meters: findVal('geofencing_radius_meters') || '100',
          system_timezone: findVal('system_timezone') || 'Asia/Kolkata',
          dept_manager_min_tenure_months: findVal('dept_manager_min_tenure_months') || '6',
          dept_manager_transition_days: findVal('dept_manager_transition_days') || '14',
          task_assignment_list_mode: findVal('task_assignment_list_mode') || 'all',
          // Deliberately no `|| default`: an empty value is the meaningful
          // "no backdating limit" setting, not a missing one.
          employee_start_date_max_past_days: findVal('employee_start_date_max_past_days') ?? '',
          employee_start_date_max_future_days: findVal('employee_start_date_max_future_days') || '180',
          employee_start_date_floor: findVal('employee_start_date_floor') || '1970-01-01',
          document_engine_enabled: findVal('document_engine_enabled') || 'false',
        });
        parsePayrollSettings(list);
        parseOvertimeSettings(list);
      }
    } catch (error) {
      console.error('Failed to fetch system settings:', error);
    }
  };

  // ── Preset ────────────────────────────────────────────────────────────────

  const handleApplyPreset = async (preset: CountryPreset) => {
    setApplyingPreset(true);
    try {
      await systemSettingsService.applyPreset(preset);
      // Spread over current state so the display preference (and any field a
      // preset omits) survives applying a country preset.
      setPayroll(p => ({ ...p, ...COUNTRY_PRESETS[preset] }));
      setCustomLabels(EMPTY_LABELS); // reset labels to country-meta defaults
      setPresetApplied(preset);
      const meta = COUNTRY_META[preset];
      toast.success(`${meta?.flag ?? ''} ${meta?.name ?? preset} payroll preset applied!`);
      setTimeout(() => setPresetApplied(null), 3000);
    } catch {
      toast.error('Failed to apply preset');
    } finally {
      setApplyingPreset(false);
    }
  };

  // ── Country meta helper ───────────────────────────────────────────────────

  const countryMeta = COUNTRY_META[payroll.payroll_country] ?? COUNTRY_META['CUSTOM'];
  const currSym = payroll.payroll_currency_symbol || payroll.payroll_currency || '¤';

  // ── Custom label resolver ───────────────────────────────────────────────────

  /** Returns the saved custom label, or falls back to the countryMeta default. */
  const getLabel = (key: LabelKey): string => {
    const saved = customLabels[key]?.trim();
    if (saved) return saved;
    const entry = LABEL_ENTRIES.find(e => e.key === key);
    return entry ? entry.getDefault(countryMeta) : key;
  };

  // ── Update Password ────────────────────────────────────────────────────────

  const handleUpdatePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!oldPassword || !newPassword || !confirmPassword) {
      toast.error('All password fields are required');
      return;
    }

    if (newPassword !== confirmPassword) {
      toast.error('New passwords do not match');
      return;
    }

    const validation = passwordSchema.safeParse(newPassword);
    if (!validation.success) {
      const errorMsg = validation.error.issues[0]?.message || 'Invalid password format';
      toast.error(errorMsg);
      return;
    }

    setIsChangingPassword(true);
    try {
      const res = await authService.changePassword({
        oldPassword,
        newPassword,
      });

      if (res.success) {
        toast.success(res.message || 'Password updated successfully!');
        setOldPassword('');
        setNewPassword('');
        setConfirmPassword('');
      } else {
        toast.error(res.message || 'Failed to update password');
      }
    } catch (error: any) {
      toast.error(error?.response?.data?.message || error?.message || 'Failed to update password');
    } finally {
      setIsChangingPassword(false);
    }
  };

  // ── Save ─────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    setSaving(true);
    try {
      if (user?.role === 'ADMIN' && (activeTab === 'system' || activeTab === 'branding' || activeTab === 'payroll' || activeTab === 'overtime')) {
        const settingsPayload: Record<string, string> = {
          // Core system
          allow_multiple_checkin: String(systemSettings.allow_multiple_checkin),
          attendance_face_only: String(systemSettings.attendance_face_only),
          face_recognition_enabled: String(systemSettings.face_recognition_enabled),
          attendance_daily_report_enabled: String(systemSettings.attendance_daily_report_enabled),
          attendance_daily_report_time: systemSettings.attendance_daily_report_time,
          attendance_day_end_time: systemSettings.attendance_day_end_time,
          strict_attendance_mode: String(systemSettings.strict_attendance_mode),
          monthly_attendance_request_limit: String(systemSettings.monthly_attendance_request_limit),
          leave_approval_hierarchy_enabled: String(systemSettings.leave_approval_hierarchy_enabled),
          allow_hard_delete_terminated: String(systemSettings.allow_hard_delete_terminated),
          // Mail transport is developer-owned, and POST /system-settings refuses
          // the WHOLE payload if it carries even one developer key while the
          // session is not elevated. Sending these unconditionally therefore
          // 403'd every save of every unrelated setting — and had it gone
          // through it would have written the blanks the unelevated GET hands
          // back over live SMTP config.
          //
          // The gate is what the SERVER returned, not `devElevated`. Elevation
          // is inferred client-side as `enforced ? hasLiveToken : true`, and
          // `enforced` defaults to false and stays false if the status probe
          // fails — so a failed probe reads as elevated and would send the
          // blanks right back into the 403. Never writing back a key the server
          // declined to show us cannot drift from the server that way.
          ...(mailKeysVisible
            ? {
              mail_enabled: String(systemSettings.mail_enabled),
              mail_host: systemSettings.mail_host,
              mail_port: systemSettings.mail_port,
              mail_user: systemSettings.mail_user,
              mail_password: systemSettings.mail_password,
              mail_from: systemSettings.mail_from,
              mail_from_name: systemSettings.mail_from_name,
              mail_bcc: systemSettings.mail_bcc,
            }
            : {}),
          // Company Branding
          company_name: systemSettings.company_name,
          company_subtitle: systemSettings.company_subtitle,
          company_logo_url: systemSettings.company_logo_url,
          company_logo_svg: systemSettings.company_logo_svg,
          company_name_image_url: systemSettings.company_name_image_url,
          company_shortname: systemSettings.company_shortname,
          theme_preset: systemSettings.theme_preset,
          theme_font: systemSettings.theme_font,
          theme_custom_colors: systemSettings.theme_custom_colors,
          theme_custom_font_family: systemSettings.theme_custom_font_family,
          theme_custom_font_url: systemSettings.theme_custom_font_url,
          // Calendar & Scheduling
          calendar_weekly_holidays: systemSettings.calendar_weekly_holidays,
          visa_expiry_alert_days: systemSettings.visa_expiry_alert_days,
          shift_reminder_prior_mins: systemSettings.shift_reminder_prior_mins,
          shift_reminder_post_mins: systemSettings.shift_reminder_post_mins,
          office_start_time: systemSettings.office_start_time,
          office_end_time: systemSettings.office_end_time,
          lunch_break_start: systemSettings.lunch_break_start,
          lunch_break_duration_minutes: String(systemSettings.lunch_break_duration_minutes),
          geofencing_enabled: String(systemSettings.geofencing_enabled),
          office_latitude: systemSettings.office_latitude,
          office_longitude: systemSettings.office_longitude,
          geofencing_radius_meters: String(systemSettings.geofencing_radius_meters),
          system_timezone: systemSettings.system_timezone,
          dept_manager_min_tenure_months: systemSettings.dept_manager_min_tenure_months,
          dept_manager_transition_days: systemSettings.dept_manager_transition_days,
          task_assignment_list_mode: systemSettings.task_assignment_list_mode,
          employee_start_date_max_past_days: systemSettings.employee_start_date_max_past_days,
          employee_start_date_max_future_days: systemSettings.employee_start_date_max_future_days,
          employee_start_date_floor: systemSettings.employee_start_date_floor,
          document_engine_enabled: systemSettings.document_engine_enabled,
          // Payroll — General
          payroll_country: payroll.payroll_country,
          payroll_currency: payroll.payroll_currency,
          payroll_currency_symbol: payroll.payroll_currency_symbol,
          payroll_currency_display: payroll.payroll_currency_display || 'symbol',
          payroll_work_hours_per_day: payroll.payroll_work_hours_per_day,
          payroll_work_days_per_week: payroll.payroll_work_days_per_week,
          payroll_overtime_rate: payroll.payroll_overtime_rate,
          payroll_basic_salary_percentage: payroll.payroll_basic_salary_percentage,
          // PF
          payroll_pf_enabled: String(payroll.payroll_pf_enabled),
          payroll_pf_employee_rate: payroll.payroll_pf_employee_rate,
          payroll_pf_employer_rate: payroll.payroll_pf_employer_rate,
          payroll_pf_salary_cap: payroll.payroll_pf_salary_cap,
          payroll_pf_on_full_salary: String(payroll.payroll_pf_on_full_salary),
          // PT
          payroll_professional_tax_enabled: String(payroll.payroll_professional_tax_enabled),
          payroll_professional_tax_slabs: JSON.stringify(payroll.payroll_professional_tax_slabs),
          // TDS
          payroll_tax_regime: payroll.payroll_tax_regime,
          payroll_standard_deduction: payroll.payroll_standard_deduction,
          payroll_personal_deduction_monthly: payroll.payroll_personal_deduction_monthly,
          payroll_tax_calculation_period: payroll.payroll_tax_calculation_period,
          payroll_tax_brackets: JSON.stringify(payroll.payroll_tax_brackets),
          payroll_tax_rebate_enabled: String(payroll.payroll_tax_rebate_enabled),
          payroll_tax_rebate_limit: payroll.payroll_tax_rebate_limit,
          payroll_cess_enabled: String(payroll.payroll_cess_enabled),
          payroll_cess_rate: payroll.payroll_cess_rate,
          // ESI
          payroll_esi_enabled: String(payroll.payroll_esi_enabled),
          payroll_esi_employee_rate: payroll.payroll_esi_employee_rate,
          payroll_esi_employer_rate: payroll.payroll_esi_employer_rate,
          payroll_esi_salary_cap: payroll.payroll_esi_salary_cap,
          // Gratuity
          payroll_daily_wage_statutory_deductions: String(payroll.payroll_daily_wage_statutory_deductions),
          payroll_daily_wage_pay_leave: String(payroll.payroll_daily_wage_pay_leave),
          payroll_daily_wage_pay_holidays: String(payroll.payroll_daily_wage_pay_holidays),
          // Declared once, written as a group. Nothing else in this payload has
          // to know they exist.
          ...Object.fromEntries(
            Object.entries(featureFlags).map(([k, v]) => [k, String(v)]),
          ),
          // Custom labels (empty = use country-meta default)
          ...customLabels,
          // Overtime Settings
          overtime_enabled: String(overtimeSettings.overtime_enabled),
          overtime_late_threshold: overtimeSettings.overtime_late_threshold,
          overtime_food_allowance_enabled: String(overtimeSettings.overtime_food_allowance_enabled),
          overtime_food_allowance_threshold: overtimeSettings.overtime_food_allowance_threshold,
          overtime_food_allowance_amount: overtimeSettings.overtime_food_allowance_amount,
          overtime_regular_rate: overtimeSettings.overtime_regular_rate,
          overtime_late_rate: overtimeSettings.overtime_late_rate,
          overtime_double_ot_enabled: String(overtimeSettings.overtime_double_ot_enabled),
          overtime_double_rate: overtimeSettings.overtime_double_rate,
          overtime_sunday_regular_rate: overtimeSettings.overtime_sunday_regular_rate,
          overtime_sunday_late_rate: overtimeSettings.overtime_sunday_late_rate,
          overtime_sunday_late_threshold: overtimeSettings.overtime_sunday_late_threshold,
          overtime_holiday_regular_rate: overtimeSettings.overtime_holiday_regular_rate,
          overtime_holiday_late_rate: overtimeSettings.overtime_holiday_late_rate,
          overtime_holiday_late_threshold: overtimeSettings.overtime_holiday_late_threshold,
          overtime_shift_end_time: overtimeSettings.overtime_shift_end_time,
          overtime_double_food_allowance_any_time: String(overtimeSettings.overtime_double_food_allowance_any_time),
          overtime_double_ot_allow_anytime: String(overtimeSettings.overtime_double_ot_allow_anytime),
          overtime_max_hours_per_day: overtimeSettings.overtime_max_hours_per_day,
          overtime_max_hours_per_month: overtimeSettings.overtime_max_hours_per_month,
          overtime_max_hours_per_year: overtimeSettings.overtime_max_hours_per_year,
          overtime_require_manager_approval: String(overtimeSettings.overtime_require_manager_approval),
          overtime_allow_employee_submit: String(overtimeSettings.overtime_allow_employee_submit),
          overtime_require_reason: String(overtimeSettings.overtime_require_reason),
          // Reimbursement Settings
          // Advance & Loan Settings
        };
        await systemSettingsService.update(settingsPayload);

        // Apply currency formatting immediately (symbol/code + symbol/currency)
        // so all amounts re-render without a page reload.
        setDefaultCurrency(
          payroll.payroll_currency,
          payroll.payroll_currency_symbol,
          payroll.payroll_currency_display || 'symbol',
        );

        // Live update the Zustand store so changes propagate immediately
        useBrandingStore.getState().updateBrandingState({
          company_name: systemSettings.company_name,
          company_subtitle: systemSettings.company_subtitle,
          company_logo_url: systemSettings.company_logo_url,
          company_logo_svg: systemSettings.company_logo_svg,
          company_name_image_url: systemSettings.company_name_image_url,
          office_start_time: systemSettings.office_start_time,
          office_end_time: systemSettings.office_end_time,
          system_timezone: systemSettings.system_timezone,
          task_assignment_list_mode: systemSettings.task_assignment_list_mode,
          overtime_enabled: overtimeSettings.overtime_enabled,
          leave_approval_hierarchy_enabled: systemSettings.leave_approval_hierarchy_enabled,
          theme_preset: systemSettings.theme_preset,
          theme_font: systemSettings.theme_font,
          theme_custom_colors: systemSettings.theme_custom_colors,
          theme_custom_font_family: systemSettings.theme_custom_font_family,
          theme_custom_font_url: systemSettings.theme_custom_font_url,
        });

        // Pull server truth (incl. the freshly generated favicon URL) so the
        // browser-tab icon updates without a page reload.
        await useBrandingStore.getState().fetchBranding();

        toast.success(
          activeTab === 'payroll'
            ? 'Payroll settings saved successfully!'
            : activeTab === 'overtime'
              ? 'Overtime settings saved successfully!'
              : 'System settings saved successfully!'
        );
      } else if (activeTab === 'general' && user?.employeeId) {
        // Persist the employee's personal display preferences ('' timezone =
        // inherit company) and refresh the auth user so dates/times across the
        // app re-render in the chosen zone + format.
        await employeeService.update(user.employeeId, {
          timezone: personalTz || null,
          dateFormat: personalDateFormat || null,
        });
        setDefaultDateFormat(personalDateFormat); // apply immediately, before refetch
        await loadUser();
        toast.success('Preferences saved successfully!');
      } else {
        // Deliberately silent. Reaching here means the footer rendered on a tab
        // `handleSave` cannot save — a gap in `SELF_SAVING_TABS`, not something
        // the user did. Announcing success would hide it; the one thing this
        // branch must never do is claim a save that did not happen.
        console.warn(
          `[settings] Save pressed on "${activeTab}", which has no save path. ` +
            'The tab belongs in SELF_SAVING_TABS.',
        );
      }
    } catch (error: any) {
      toast.error(error?.response?.data?.message || error?.message || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  // ── PT Slab Editor ────────────────────────────────────────────────────────

  const updatePtSlab = (index: number, field: keyof PtSlab, value: string) => {
    const updated = [...payroll.payroll_professional_tax_slabs];
    updated[index] = { ...updated[index], [field]: Number(value) };
    setPayroll(p => ({ ...p, payroll_professional_tax_slabs: updated }));
  };

  const addPtSlab = () => {
    setPayroll(p => ({
      ...p,
      payroll_professional_tax_slabs: [...p.payroll_professional_tax_slabs, { upTo: 0, tax: 0 }],
    }));
  };

  const removePtSlab = (index: number) => {
    setPayroll(p => ({
      ...p,
      payroll_professional_tax_slabs: p.payroll_professional_tax_slabs.filter((_, i) => i !== index),
    }));
  };

  // ── Tax Bracket Editor ────────────────────────────────────────────────────

  const updateBracket = (index: number, field: keyof TaxBracket, value: string) => {
    const updated = [...payroll.payroll_tax_brackets];
    updated[index] = { ...updated[index], [field]: Number(value) };
    setPayroll(p => ({ ...p, payroll_tax_brackets: updated }));
  };

  const addBracket = () => {
    setPayroll(p => ({
      ...p,
      payroll_tax_brackets: [...p.payroll_tax_brackets, { limit: 0, rate: 0 }],
    }));
  };

  const removeBracket = (index: number) => {
    setPayroll(p => ({
      ...p,
      payroll_tax_brackets: p.payroll_tax_brackets.filter((_, i) => i !== index),
    }));
  };

  // ── Tabs ──────────────────────────────────────────────────────────────────

  // Keyed by tab id rather than by index: the rail's contents depend on role and
  // on elevation, so an index would point at a different tab the moment a
  // developer tab appears or lapses.
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  /**
   * The rail, grouped by WHOSE settings these are rather than as one flat list.
   *
   * Three of these tabs change nothing but the caller's own experience, and the
   * rest change the company for everybody — a single unbroken column asked the
   * reader to know which was which from the label alone. The headings are
   * desktop-only: on a phone the rail is a horizontal scroller, so each group
   * renders as `display: contents` and its tabs stay in the one flex row.
   *
   * A group whose tabs all filtered away renders nothing at all, heading
   * included — an empty "Company" caption is a promise the rail cannot keep.
   */
  const tabGroups: SettingsTabGroup[] = [
    {
      id: 'you',
      label: 'Your account',
      tabs: [
        { id: 'general', label: 'General', icon: Settings, hint: 'Language, time zone and date format' },
        { id: 'notifications', label: 'Notifications', icon: Bell, hint: 'What reaches you, and where' },
        { id: 'security', label: 'Security', icon: Shield, hint: 'Password and active sessions' },
      ],
    },
    {
      id: 'company',
      label: 'Company',
      tabs: [
        ...(user?.role === 'ADMIN' || user?.role === 'HR_MANAGER'
          ? [
            { id: 'holidays', label: 'Holidays', icon: Calendar, hint: 'The working calendar everybody is measured against' },
            { id: 'approvals', label: 'Approval Hierarchy', icon: GitBranch, hint: 'Who signs what' },
          ]
          : []),
        ...(user?.role === 'ADMIN' ? [
          { id: 'system', label: 'System Settings', icon: Sliders, hint: 'Global rules and compliance' },
          { id: 'branding', label: 'Branding & Theme', icon: Palette, hint: 'Logo, palette and typeface' },
          { id: 'payroll', label: 'Payroll Settings', icon: CurrencyIcon, hint: 'Currency, statutory rates and brackets' },
          { id: 'overtime-policies', label: 'Overtime Policies', icon: Clock, hint: 'Rates and limits per employment type' },
          { id: 'libraries', label: 'Libraries', icon: BookOpen, hint: 'The option sets the forms bind to' },
        ] : []),
      ],
    },
    {
      // Operator-owned surfaces. Hidden outright — not greyed out — so an admin
      // cannot tell they exist. The backend refuses the matching routes with a
      // flat 403, so hiding these is convenience, not the security boundary.
      id: 'developer',
      label: 'Developer',
      tabs: devElevated
        ? [{ id: 'copilot', label: 'HR Copilot', icon: Sparkles, hint: 'Model, retrieval and the assistant tone' }]
        : [],
    },
  ].filter((group) => group.tabs.length > 0);

  /** Flat reading order — what the arrow keys walk, headings ignored. */
  const tabs = tabGroups.flatMap((group) => group.tabs);

  /**
   * Arrow keys move between tabs, as a tablist is expected to.
   *
   * The rail is a column on desktop and a row on a phone, so both axes move and
   * both wrap; Home/End jump to the ends. Selection follows focus, which is the
   * right call HERE because every panel is already mounted client-side — there
   * is no request to fire per tab the key passes through.
   */
  const onTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === 'ArrowDown' || event.key === 'ArrowRight'
        ? 1
        : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
          ? -1
          : 0;

    let next = -1;
    if (step !== 0) {
      const at = tabs.findIndex((tab) => tab.id === activeTab);
      next = (at + step + tabs.length) % tabs.length;
    } else if (event.key === 'Home') {
      next = 0;
    } else if (event.key === 'End') {
      next = tabs.length - 1;
    }
    if (next < 0) return;

    event.preventDefault();
    const target = tabs[next];
    setActiveTab(target.id);
    tabRefs.current[target.id]?.focus();
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <div className="space-y-4 sm:space-y-5" data-testid="ess-settings">
        {/* The title/subtitle live in the sticky TopHeader, declared via
            usePageHeader above. Developer mode stays here rather than in the
            global header: the only thing it unlocks is on this page, and it
            renders nothing at all unless the caller is an ADMIN on a deployment
            that has a developer password configured. */}
        <PageActionRow action={<DevModeToggle />} />

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 lg:gap-6">
          {/* Sidebar Tabs */}
          <div className="lg:col-span-1 lg:sticky lg:top-4 lg:self-start">
            <div
              role="tablist"
              aria-label="Settings sections"
              aria-orientation="vertical"
              onKeyDown={onTabKeyDown}
              className="surface-panel p-1.5 flex gap-1 overflow-x-auto no-scrollbar lg:block lg:space-y-0.5"
            >
              {tabGroups.map((group, index) => (
                // `contents` keeps the phone rail one flat scrolling row: the
                // wrapper draws no box of its own, so the tabs remain direct
                // flex children and nothing wraps mid-scroll.
                <div key={group.id} className="contents lg:block">
                  <p
                    className={`hidden lg:block px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted/70 ${index === 0 ? 'pt-1' : 'pt-3'}`}
                  >
                    {group.label}
                  </p>
                  {group.tabs.map(tab => {
                    const Icon = tab.icon;
                    const selected = activeTab === tab.id;
                    return (
                      <button
                        key={tab.id}
                        // Tabs are client state, not routes, so a test has no href
                        // to navigate to and the label is translated.
                        data-testid={`settings-tab-${tab.id}`}
                        ref={(node) => { tabRefs.current[tab.id] = node; }}
                        role="tab"
                        id={`settings-tab-button-${tab.id}`}
                        aria-selected={selected}
                        aria-controls={SETTINGS_PANEL_ID}
                        // Roving tabindex: one stop for the whole rail, then the
                        // arrow keys move within it. Nine separate tab stops
                        // between the header and the form is not navigation.
                        tabIndex={selected ? 0 : -1}
                        title={tab.hint}
                        onClick={() => setActiveTab(tab.id)}
                        className={`relative shrink-0 lg:w-full flex items-center gap-2 h-11 lg:h-9 px-3 rounded-lg transition-colors whitespace-nowrap touch-manipulation focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/40 ${selected
                          ? 'text-text-on-brand'
                          : 'text-text-muted hover:bg-surface-page'}`}
                      >
                        {/* One shared element rather than a background per
                            button, so the highlight travels between tabs
                            instead of blinking out and in somewhere else. */}
                        {selected && (
                          <motion.span
                            layoutId="settings-tab-highlight"
                            transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                            className="absolute inset-0 rounded-lg bg-brand-primary shadow-sm"
                          />
                        )}
                        <Icon size={16} className="relative shrink-0" />
                        <span className="relative font-medium text-sm">{tab.label}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>

          {/* Content */}
          <div className="lg:col-span-4">
            <motion.div
              key={activeTab}
              // One panel that swaps contents rather than one node per tab: the
              // rail's `aria-controls` then has a single stable target, and the
              // remount is what replays the enter animation on every switch.
              id={SETTINGS_PANEL_ID}
              role="tabpanel"
              aria-labelledby={`settings-tab-button-${activeTab}`}
              tabIndex={-1}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-4 sm:space-y-5 focus:outline-none"
            >
              {/* ── Holidays ── */}
              {activeTab === 'holidays' && <HolidaysManager />}

              {/* ── General ── */}
              {activeTab === 'general' && (
                <div className="surface-panel p-4 sm:p-5 space-y-4">
                  <h2 className="text-sm sm:text-base font-semibold text-text-heading">General settings</h2>
                  <div>
                    <label className="flex items-center gap-2 text-xs font-medium text-slate-700 mb-1.5">
                      <Globe size={16} className="text-brand-primary" /> Language
                      <InfoHint text="Sets the display language for the entire application interface." example="Switching to Hindi changes all UI labels, menu items, and buttons to Hindi." />
                    </label>
                    <select value={settings.language} onChange={e => setSettings({ ...settings, language: e.target.value })}
                      className="w-full h-10 px-3 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/30 transition-all">
                      <option value="en">English</option>
                      <option value="hi">Hindi</option>
                    </select>
                  </div>
                  <div>
                    <label className="flex items-center gap-1.5 text-xs font-medium text-slate-700 mb-1.5">
                      Time zone
                      <InfoHint text="Your personal timezone for displaying timestamps across the app. Leave on 'Company default' to follow the timezone your admin set." example={`Company default is currently ${companyTz} (${utcOffsetLabel(companyTz)}).`} />
                    </label>
                    <TimezoneSelect
                      value={personalTz}
                      onChange={tz => setPersonalTz(tz || '')}
                      includeInherit
                      inheritLabel={`Company default — ${companyTz} (${utcOffsetLabel(companyTz)})`}
                    />
                    <p className="mt-1.5 text-xs text-slate-400">
                      {personalTz
                        ? `Times shown in your timezone: ${personalTz} (${utcOffsetLabel(personalTz)}).`
                        : `Following the company timezone: ${companyTz} (${utcOffsetLabel(companyTz)}).`}
                    </p>
                  </div>
                  <div>
                    <label className="flex items-center gap-1.5 text-xs font-medium text-slate-700 mb-1.5">
                      Date format
                      <InfoHint text="Controls how dates appear across the application." example="DD/MM/YYYY → 30/06/2026 · MM/DD/YYYY → 06/30/2026 · YYYY-MM-DD → 2026-06-30 (ISO 8601)" />
                    </label>
                    <select
                      value={personalDateFormat}
                      onChange={e => setPersonalDateFormat(e.target.value)}
                      className="w-full h-10 px-3 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/30">
                      <option value="DD/MM/YYYY">DD/MM/YYYY</option>
                      <option value="MM/DD/YYYY">MM/DD/YYYY</option>
                      <option value="YYYY-MM-DD">YYYY-MM-DD</option>
                    </select>
                    <p className="mt-1.5 text-xs text-slate-400">
                      Example today: {(() => {
                        const now = new Date();
                        const dd = String(now.getDate()).padStart(2, '0');
                        const mm = String(now.getMonth() + 1).padStart(2, '0');
                        const yyyy = String(now.getFullYear());
                        return personalDateFormat === 'MM/DD/YYYY'
                          ? `${mm}/${dd}/${yyyy}`
                          : personalDateFormat === 'YYYY-MM-DD'
                            ? `${yyyy}-${mm}-${dd}`
                            : `${dd}/${mm}/${yyyy}`;
                      })()}
                    </p>
                  </div>
                  {user?.role === 'ADMIN' && (
                    <div className="pt-4 border-t border-slate-200">
                      <label className="flex items-center gap-1.5 text-xs font-medium text-slate-700 mb-1.5">
                        Dashboard layout
                        <InfoHint text="Organisation-wide setting: choose which dashboard design loads at /dashboard for all admin/HR/manager users. Saved to the database; takes effect next time the dashboard opens." />
                      </label>
                      <div className="grid grid-cols-2 gap-4">
                        {([
                          { value: 'v2', label: 'Modern (V2)', desc: 'Single-screen cockpit layout' },
                          { value: 'v1', label: 'Classic (V1)', desc: 'Original scrollable layout' },
                        ] as { value: DashboardVersion; label: string; desc: string }[]).map(opt => (
                          <button key={opt.value} onClick={() => handleDashboardVersionChange(opt.value)}
                            className={`p-3 rounded-lg border text-left transition-all ${settings.dashboardVersion === opt.value ? 'border-brand-primary bg-brand-primary/5' : 'border-slate-200 hover:border-slate-300'}`}>
                            <p className="text-sm font-medium text-text-heading">{opt.label}</p>
                            <p className="text-xs text-slate-400 mt-0.5">{opt.desc}</p>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* ── Notifications ── */}
              {activeTab === 'notifications' && (
                <div className="surface-panel p-4 sm:p-5 space-y-4">
                  <h2 className="text-sm sm:text-base font-semibold text-text-heading">Notifications</h2>
                  <div className="space-y-4">
                    <h3 className="text-sm font-semibold text-slate-700">Notification channel</h3>
                    {[
                      { key: 'email' as const, label: 'Email', desc: 'Receive email notifications', icon: Mail, bg: 'bg-status-info-bg', hint: 'Receive notifications via your registered email address.', example: 'A leave approval sends an email to your inbox with the approved dates and remarks.' },
                      { key: 'push' as const, label: 'Push Notifications', desc: 'Browser notifications', icon: Bell, bg: 'bg-status-success-bg', hint: 'Receive real-time in-browser push alerts for system events.', example: 'A browser pop-up appears the moment your overtime request is approved by your manager.' },
                    ].map(item => (
                      <label key={item.key} className="flex items-center justify-between gap-3 px-3 py-2.5 bg-slate-50 rounded-lg cursor-pointer hover:bg-slate-100 transition-colors">
                        <div className="flex items-center gap-3">
                          <div className={`w-8 h-8 ${item.bg} rounded-lg flex items-center justify-center`}><item.icon size={16} className="text-text-body" /></div>
                          <div>
                            <p className="text-sm font-medium text-text-heading flex items-center gap-1.5">{item.label} <InfoHint text={item.hint} example={item.example} /></p>
                            <p className="text-xs text-slate-500">{item.desc}</p>
                          </div>
                        </div>
                        <input type="checkbox" checked={settings.notifications[item.key]}
                          onChange={e => setSettings({ ...settings, notifications: { ...settings.notifications, [item.key]: e.target.checked } })}
                          className="w-5 h-5 rounded border-slate-300 text-brand-primary focus:ring-2 focus:ring-brand-primary/20" />
                      </label>
                    ))}
                  </div>
                  <div className="space-y-4 pt-4 border-t border-slate-200">
                    <h3 className="text-sm font-semibold text-slate-700">Notification types</h3>
                    {[
                      { key: 'leaveApproval', label: 'Leave approval', desc: 'When there is a new leave application', hint: 'Get notified when a leave request is submitted, approved, or rejected.', example: 'Your request goes from Pending → Approved and you receive an instant notification.' },
                      { key: 'overtimeApproval', label: 'Overtime approval', desc: 'When there is a new overtime request', hint: 'Get notified about overtime request status changes.', example: 'After a manager approves your OT request, you receive a notification with the approved hours.' },
                      { key: 'payroll', label: 'Payroll', desc: 'Monthly payroll notification', hint: 'Get notified when your monthly payslip is processed and ready to view.', example: 'End of month: payroll is run, you receive a notification with a link to your payslip.' },
                    ].map(item => (
                      <label key={item.key} className="flex items-center justify-between gap-3 px-3 py-2.5 hover:bg-slate-50 rounded-lg transition-colors cursor-pointer">
                        <div>
                          <p className="text-sm font-medium text-text-heading flex items-center gap-1.5">{item.label} <InfoHint text={item.hint} example={item.example} /></p>
                          <p className="text-xs text-slate-500">{item.desc}</p>
                        </div>
                        <input type="checkbox"
                          checked={settings.notifications[item.key as keyof typeof settings.notifications] as boolean}
                          onChange={e => setSettings({ ...settings, notifications: { ...settings.notifications, [item.key]: e.target.checked } })}
                          className="w-5 h-5 rounded border-slate-300 text-brand-primary focus:ring-2 focus:ring-brand-primary/20" />
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {/* ── Security ── */}
              {activeTab === 'security' && (
                <div className="surface-panel p-4 sm:p-5 space-y-4">
                  <h2 className="text-sm sm:text-base font-semibold text-text-heading">Security</h2>
                  <div className="space-y-4">
                    <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2"><Key size={16} className="text-brand-primary" />Change password</h3>
                    <form onSubmit={handleUpdatePassword} className="space-y-3">
                      <input
                        type="password"
                        placeholder="Current password"
                        value={oldPassword}
                        onChange={e => setOldPassword(e.target.value)}
                        className="w-full h-10 px-3 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/30"
                        disabled={isChangingPassword}
                      />
                      <input
                        type="password"
                        placeholder="New password"
                        value={newPassword}
                        onChange={e => setNewPassword(e.target.value)}
                        className="w-full h-10 px-3 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/30"
                        disabled={isChangingPassword}
                      />
                      <input
                        type="password"
                        placeholder="Confirm new password"
                        value={confirmPassword}
                        onChange={e => setConfirmPassword(e.target.value)}
                        className="w-full h-10 px-3 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/30"
                        disabled={isChangingPassword}
                      />
                      <button
                        type="submit"
                        disabled={isChangingPassword}
                        className="inline-flex items-center justify-center h-10 px-4 w-full sm:w-auto bg-brand-primary hover:bg-brand-primary-dark text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
                      >
                        {isChangingPassword ? 'Updating password...' : 'Update password'}
                      </button>
                    </form>
                  </div>
                  <div className="pt-6 border-t border-slate-200">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-1.5">2-Factor Authentication (2FA) <InfoHint text="Adds a second login verification step using an authenticator app, making your account significantly more secure." example="After entering your password, your app shows a 6-digit code — enter it to complete login." /></h3>
                        <p className="text-xs text-slate-500 mt-1">Enhance account security with 2-factor authentication</p>
                      </div>
                      <button className="h-9 px-3 shrink-0 border border-brand-primary text-brand-primary text-sm rounded-lg hover:bg-brand-primary/5 transition-colors font-medium">Turn on 2FA</button>
                    </div>
                  </div>
                </div>
              )}

              {/* ── Appearance ── */}
              {activeTab === 'appearance' && (
                <div className="surface-panel p-4 sm:p-5 space-y-4">
                  <h2 className="text-sm sm:text-base font-semibold text-text-heading">Interface</h2>
                  <div>
                    <h3 className="text-sm font-semibold text-slate-700 mb-3">Display mode</h3>
                    <div className="grid grid-cols-3 gap-4">
                      {[{ value: 'light', label: 'Bright' }, { value: 'dark', label: 'Dark' }, { value: 'auto', label: 'Automatic' }].map(theme => (
                        <button key={theme.value} onClick={() => setSettings({ ...settings, theme: theme.value })}
                          className={`p-3 rounded-lg border transition-all ${settings.theme === theme.value ? 'border-brand-primary bg-brand-primary/5' : 'border-slate-200 hover:border-slate-300'}`}>
                          <p className="text-sm font-medium text-text-heading">{theme.label}</p>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="pt-6 border-t border-slate-200">
                    <h3 className="text-sm font-semibold text-slate-700 mb-3">Sidebar color</h3>
                    <div className="flex gap-3">
                      {['#00358F', '#f66600', '#10b981', '#8b5cf6', '#ef4444'].map(color => (
                        <button key={color} className="w-10 h-10 rounded-lg shadow-sm hover:scale-110 transition-transform" style={{ backgroundColor: color }} />
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* ── System Settings ── */}
              {/* ── Branding & Theme ── */}
              {activeTab === 'branding' && user?.role === 'ADMIN' && (
                <div className="space-y-4 sm:space-y-5">
                  {/* Header card */}
                  <div className="surface-panel p-4 sm:p-5">
                    <h2 className="text-sm sm:text-base font-semibold text-text-heading mb-0.5">Branding &amp; Theme</h2>
                    <p className="text-xs text-slate-500">Customize the company identity, colors, and fonts shown across the application</p>
                  </div>

                  {/* ─ Company Branding ─ */}
                  <SectionCard title="Company Branding" icon={Building2} badge="Customize application look and feel" collapsible>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4">
                      <FieldRow label="Company Name" icon={Building2} hint={<InfoHint text="Displayed in the sidebar header, browser tab, email signatures, and payslip headers." example="'The Company' appears in the top-left sidebar and as the sender name in system emails." />}>
                        <InputField
                          value={systemSettings.company_name}
                          onChange={v => setSystemSettings(s => ({ ...s, company_name: v }))}
                          placeholder="The Company"
                        />
                      </FieldRow>
                      <FieldRow label="Subtitle / Designation" icon={Tag} hint={<InfoHint text="A short tagline or role description shown below the company name in the sidebar." example="'TRS ADMIN' appears under the company name in the sidebar navigation." />}>
                        <InputField
                          value={systemSettings.company_subtitle}
                          onChange={v => setSystemSettings(s => ({ ...s, company_subtitle: v }))}
                          placeholder="TRS ADMIN"
                        />
                      </FieldRow>
                      <FieldRow label="Company Shortname" icon={Tag} hint={<InfoHint text="An abbreviated version of the company name used in compact UI areas and as a logo fallback." example="'TRS' is shown as initials in the sidebar when the logo image fails to load." />}>
                        <InputField
                          value={systemSettings.company_shortname}
                          onChange={v => setSystemSettings(s => ({ ...s, company_shortname: v }))}
                          placeholder="TRS"
                        />
                      </FieldRow>
                      <FieldRow label="Logo Image URL" icon={Globe} hint={<InfoHint text="URL of the company logo image shown in the sidebar. Supported formats: PNG, JPG, SVG, WebP." example="Paste a CDN URL like https://cdn.yourcompany.com/logo.png to display your company logo." />}>
                        <div className="flex gap-2">
                          <InputField
                            value={systemSettings.company_logo_url}
                            onChange={v => setSystemSettings(s => ({ ...s, company_logo_url: v }))}
                            placeholder="https://example.com/logo.png"
                          />
                          <input
                            type="file"
                            id="logo-upload"
                            className="hidden"
                            accept="image/*"
                            onChange={async (e) => {
                              const file = e.target.files?.[0];
                              if (!file) return;
                              const loadingToast = toast.loading('Uploading logo...');
                              try {
                                const res: any = await systemSettingsService.uploadLogo(file);
                                if (res?.url) {
                                  setSystemSettings(s => ({ ...s, company_logo_url: res.url }));
                                  toast.success('Logo uploaded successfully', { id: loadingToast });
                                } else {
                                  toast.error('Failed to upload logo', { id: loadingToast });
                                }
                              } catch (err: any) {
                                toast.error(err?.response?.data?.message || 'Upload failed', { id: loadingToast });
                              }
                            }}
                          />
                          <label
                            htmlFor="logo-upload"
                            className="h-10 px-4 bg-brand-primary text-white rounded-lg hover:bg-brand-primary-dark transition-colors cursor-pointer flex items-center justify-center whitespace-nowrap text-sm font-medium"
                          >
                            Upload
                          </label>
                        </div>
                      </FieldRow>
                      <div className="flex flex-col gap-1.5 md:col-span-2">
                        <label className="text-xs font-medium text-slate-700 flex items-center gap-1.5">
                          <Edit3 size={15} className="text-slate-400" />
                          Custom SVG Code (Vector Logo)
                          <InfoHint text="Paste raw SVG markup to use as the logo. Takes priority over the Logo Image URL if provided." example="<svg>...</svg> pasted here renders a crisp vector logo at any size without quality loss." />
                        </label>
                        <textarea
                          value={systemSettings.company_logo_svg}
                          onChange={e => setSystemSettings(s => ({ ...s, company_logo_svg: e.target.value }))}
                          placeholder="<svg ...>...</svg>"
                          rows={4}
                          className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/30 transition-all text-sm bg-white font-mono"
                        />
                        <p className="text-xs text-slate-500">Paste your raw SVG code here. Note: custom SVG code takes precedence over the Image URL.</p>
                      </div>

                      {/* Company Name Image (Wordmark) — shown in the sidebar in place of the name text */}
                      <div className="flex flex-col gap-1.5 md:col-span-2">
                        <label className="text-xs font-medium text-slate-700 flex items-center gap-1.5">
                          <Tag size={15} className="text-slate-400" />
                          Company Name Image (Wordmark)
                          <InfoHint text="An image of the company name displayed in the sidebar next to the logo, replacing plain text." example="A stylized 'TRS' wordmark image is shown in the sidebar instead of plain text when provided." />
                        </label>
                        <div className="flex gap-2">
                          <InputField
                            value={systemSettings.company_name_image_url}
                            onChange={v => setSystemSettings(s => ({ ...s, company_name_image_url: v }))}
                            placeholder="https://example.com/company-name.png"
                          />
                          <input
                            type="file"
                            id="name-image-upload"
                            className="hidden"
                            accept="image/*"
                            onChange={async (e) => {
                              const file = e.target.files?.[0];
                              if (!file) return;
                              const loadingToast = toast.loading('Uploading name image...');
                              try {
                                const res: any = await systemSettingsService.uploadLogo(file);
                                if (res?.url) {
                                  setSystemSettings(s => ({ ...s, company_name_image_url: res.url }));
                                  toast.success('Name image uploaded successfully', { id: loadingToast });
                                } else {
                                  toast.error('Failed to upload name image', { id: loadingToast });
                                }
                              } catch (err: any) {
                                toast.error(err?.response?.data?.message || 'Upload failed', { id: loadingToast });
                              } finally {
                                e.target.value = '';
                              }
                            }}
                          />
                          <label
                            htmlFor="name-image-upload"
                            className="h-10 px-4 bg-brand-primary text-white rounded-lg hover:bg-brand-primary-dark transition-colors cursor-pointer flex items-center justify-center whitespace-nowrap text-sm font-medium"
                          >
                            Upload
                          </label>
                          {systemSettings.company_name_image_url && (
                            <button
                              type="button"
                              onClick={() => setSystemSettings(s => ({ ...s, company_name_image_url: '' }))}
                              className="h-10 px-3 border border-slate-200 text-slate-500 rounded-lg hover:bg-slate-50 transition-colors flex items-center justify-center"
                              title="Remove name image"
                            >
                              <Trash2 size={16} />
                            </button>
                          )}
                        </div>
                        <p className="text-xs text-slate-500">Upload your company name/wordmark image (e.g. a styled text logo). When set, it replaces the company name text in the sidebar.</p>
                        {systemSettings.company_name_image_url && (
                          <div className="mt-1 inline-flex items-center rounded-xl border-2 border-dashed border-slate-200 bg-slate-50 p-3">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={systemSettings.company_name_image_url}
                              alt="Company name"
                              className="max-h-12 w-auto object-contain"
                            />
                          </div>
                        )}
                      </div>

                      {/* Live Logo & Browser-Tab Preview */}
                      <div className="md:col-span-2">
                        <BrandingPreview
                          companyName={systemSettings.company_name}
                          logoSvg={systemSettings.company_logo_svg}
                          logoUrl={systemSettings.company_logo_url}
                        />
                      </div>
                    </div>
                  </SectionCard>

                  {/* ─ Theme & Appearance ─ */}
                  <SectionCard title="Theme & Appearance" icon={Palette} badge="Pick a color theme and font — applies live across the app" collapsible>
                    <ThemeAppearance
                      presetId={systemSettings.theme_preset}
                      fontId={systemSettings.theme_font}
                      customColorsJson={systemSettings.theme_custom_colors}
                      customFontFamily={systemSettings.theme_custom_font_family}
                      customFontUrl={systemSettings.theme_custom_font_url}
                      onSelectPreset={(id) => {
                        setSystemSettings(s => ({ ...s, theme_preset: id }));
                        useBrandingStore.getState().updateBrandingState({ theme_preset: id });
                      }}
                      onSelectCustomColors={(json) => {
                        setSystemSettings(s => ({ ...s, theme_preset: 'custom', theme_custom_colors: json }));
                        useBrandingStore.getState().updateBrandingState({ theme_preset: 'custom', theme_custom_colors: json });
                      }}
                      onSelectFont={(id) => {
                        setSystemSettings(s => ({ ...s, theme_font: id }));
                        useBrandingStore.getState().updateBrandingState({ theme_font: id });
                      }}
                      onChangeCustomColor={(json) => {
                        setSystemSettings(s => ({ ...s, theme_custom_colors: json }));
                        useBrandingStore.getState().updateBrandingState({ theme_custom_colors: json });
                      }}
                      onChangeCustomFont={(family, url) => {
                        setSystemSettings(s => ({ ...s, theme_font: 'custom', theme_custom_font_family: family, theme_custom_font_url: url }));
                        useBrandingStore.getState().updateBrandingState({ theme_font: 'custom', theme_custom_font_family: family, theme_custom_font_url: url });
                      }}
                    />
                  </SectionCard>
                </div>
              )}

              {activeTab === 'copilot' && devElevated && (
                <CopilotSettingsSection />
              )}

              {activeTab === 'approvals' &&
                (user?.role === 'ADMIN' || user?.role === 'HR_MANAGER') && (
                  <SupervisorHierarchySection />
                )}

              {activeTab === 'overtime-policies' && user?.role === 'ADMIN' && (
                <OvertimePolicySection />
              )}


              {activeTab === 'system' && user?.role === 'ADMIN' && (
                <div className="space-y-4 sm:space-y-5">
                  {/* Header card */}
                  <div className="surface-panel p-4 sm:p-5">
                    <h2 className="text-sm sm:text-base font-semibold text-text-heading mb-0.5">System Settings</h2>
                    <p className="text-xs text-slate-500">Configure global rules, payroll compliance, and permissions for the company</p>
                  </div>

                  {/* ─ Employment dates ─ */}
                  <SectionCard title="Employment Dates" icon={Calendar} badge="Joining date limits">
                    <div className="flex flex-col gap-3">
                      <p className="text-xs text-slate-500 max-w-2xl">
                        Bounds for an employee&apos;s date of employment, applied when onboarding and when importing from Excel.
                        The contract start date follows the employment date, so these limits govern both.
                      </p>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 sm:gap-4">
                        <FieldRow
                          label="Backdating limit (days)"
                          icon={Calendar}
                          hint={<InfoHint text="How far in the past a start date may be set. Leave BLANK for no limit, so employees with late paperwork or historical records can be onboarded with their real joining date." example="Blank → a 2019 joining date is accepted. 365 → anything older than a year is rejected." />}
                        >
                          <InputField
                            type="number"
                            min="0"
                            placeholder="Blank = no limit"
                            value={systemSettings.employee_start_date_max_past_days}
                            onChange={v => setSystemSettings(s => ({ ...s, employee_start_date_max_past_days: v }))}
                          />
                        </FieldRow>
                        <FieldRow
                          label="Future-dating limit (days)"
                          icon={Calendar}
                          hint={<InfoHint text="How far ahead a start date may be set. Keep this tight: a future-dated employee is created ACTIVE straight away and is included in payroll runs before they have actually joined." example="180 → a joining date up to six months out is accepted; a mistyped 2099 is rejected." />}
                        >
                          <InputField
                            type="number"
                            min="0"
                            value={systemSettings.employee_start_date_max_future_days}
                            onChange={v => setSystemSettings(s => ({ ...s, employee_start_date_max_future_days: v }))}
                          />
                        </FieldRow>
                        <FieldRow
                          label="Earliest allowed date"
                          icon={Calendar}
                          hint={<InfoHint text="Absolute floor for any employment date, regardless of the backdating limit. Catches typos rather than restricting genuine history." example="1970-01-01 → a mistyped 0202-05-01 is rejected." />}
                        >
                          <InputField
                            type="date"
                            value={systemSettings.employee_start_date_floor}
                            onChange={v => setSystemSettings(s => ({ ...s, employee_start_date_floor: v }))}
                          />
                        </FieldRow>
                      </div>
                      {!systemSettings.employee_start_date_max_past_days?.trim() && (
                        <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-600">
                          <strong>Backdating is unlimited.</strong> Any past joining date is accepted, down to the earliest allowed date.
                        </div>
                      )}
                    </div>
                  </SectionCard>

                  {/* ─ Attendance ─ */}
                  <SectionCard title="Attendance" icon={Clock} badge="Check-in / Check-out behaviour">
                    <div className="flex flex-col gap-3">
                      <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-slate-50 rounded-lg">
                        <div>
                          <p className="text-sm font-medium text-slate-800 flex items-center gap-1.5">Allow Multiple Check-ins / Check-outs <InfoHint text="Lets employees record multiple check-in/check-out pairs in one workday. Total hours are summed across all sessions." example="Check in 9 AM, out 1 PM, back in 2 PM, out 6 PM → system records 8 hrs total worked." /></p>
                          <p className="text-xs text-slate-500 mt-0.5 max-w-lg">
                            When enabled, employees can check in and out multiple times throughout the day.
                            Total worked hours are accumulated automatically.
                          </p>
                        </div>
                        <Toggle checked={systemSettings.allow_multiple_checkin} onChange={v => setSystemSettings(s => ({ ...s, allow_multiple_checkin: v }))} />
                      </div>
                      <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-slate-50 rounded-lg">
                        <div>
                          <p className="text-sm font-medium text-slate-800 flex items-center gap-1.5">Enable Facekeep Attendance (Face verification only) <InfoHint text="Requires employees to verify their face via webcam before recording attendance. Disables manual check-in from the dashboard." example="Employee opens attendance portal → camera activates → face is matched → check-in recorded automatically, no button click needed." /></p>
                          <p className="text-xs text-slate-500 mt-0.5 max-w-lg">
                            When enabled, employees are required to verify their image to record check-in and check-out. Direct manual timekeeping from the dashboard is disabled for employees.
                          </p>
                        </div>
                        <Toggle checked={systemSettings.attendance_face_only} onChange={v => setSystemSettings(s => ({ ...s, attendance_face_only: v }))} />
                      </div>
                      <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-slate-50 rounded-lg">
                        <div>
                          <p className="text-sm font-medium text-slate-800 flex items-center gap-1.5">Enable AI Face Recognition <InfoHint text="Uses the face-api.js model to compare the live webcam image against the stored face profile. When off, a photo is captured but not verified against any profile." example="AI on + face mismatch → check-in rejected and a failed attempt is logged. AI off → any face photo is accepted." /></p>
                          <p className="text-xs text-slate-500 mt-0.5 max-w-lg">
                            When enabled, the system uses the face-api.js AI model to match and verify employees' faces.
                            When disabled, the system only captures a photo from the webcam and uploads it directly (no AI verification).
                          </p>
                        </div>
                        <Toggle checked={systemSettings.face_recognition_enabled} onChange={v => setSystemSettings(s => ({ ...s, face_recognition_enabled: v }))} />
                      </div>
                      {!systemSettings.face_recognition_enabled && (
                        <div className="p-3 bg-status-warning-bg/40 border border-status-warning/20 rounded-lg text-xs text-status-warning">
                          <strong>Face recognition is disabled:</strong> The system will capture a photo from the employee's webcam and save it directly to the storage bucket. No AI verification or matching will be performed during check-in/out.
                        </div>
                      )}
                      <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-slate-50 rounded-lg">
                        <div>
                          <p className="text-sm font-medium text-slate-800 flex items-center gap-1.5">Enable Daily Attendance Report Email <InfoHint text="Sends an automated daily attendance summary to the system administrator at the configured report time." example="At 5:30 PM the admin receives an email listing present, absent, late, and on-leave employees for that day." /></p>
                          <p className="text-xs text-slate-500 mt-0.5 max-w-lg">
                            When enabled, the system sends a daily attendance summary email to the system administrator (self-mail) at the configured report time.
                          </p>
                        </div>
                        <Toggle checked={systemSettings.attendance_daily_report_enabled} onChange={v => setSystemSettings(s => ({ ...s, attendance_daily_report_enabled: v }))} />
                      </div>
                      {systemSettings.attendance_daily_report_enabled && (
                        <div className="p-3 bg-slate-50 rounded-lg">
                          <p className="text-sm font-medium text-slate-800 mb-2 flex items-center gap-1.5">Daily Report Send Time <InfoHint text="When the daily summary email is sent. Absentees are computed at send time without writing records; official Absent marking still happens at the day-end boundary." example="17:30 → the 5:30 PM report lists everyone with no check-in and no approved leave as absent, even though records are only saved at the day-end boundary." /></p>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4">
                            <FieldRow label="Send Time" icon={Clock}>
                              <InputField
                                type="time"
                                value={systemSettings.attendance_daily_report_time}
                                onChange={v => setSystemSettings(s => ({ ...s, attendance_daily_report_time: v }))}
                              />
                            </FieldRow>
                          </div>
                        </div>
                      )}
                      <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-slate-50 rounded-lg">
                        <div>
                          <p className="text-sm font-medium text-slate-800 flex items-center gap-1.5">Strict Attendance Mode <InfoHint text="Employees who forget to check out are flagged as 'Missed Checkout' at the day-end boundary. Their working hours for that day are recorded as 0." example="Employee checks in at 9 AM but forgets to check out → at the day-end boundary: 0 hrs recorded, status = 'Missed Checkout'." /></p>
                          <p className="text-xs text-slate-500 mt-0.5 max-w-lg">
                            When enabled, employees who forget to check out are marked as <strong>Missed Checkout</strong> at the day-end boundary instead of being auto-checked out. Their working hours will <strong>not</strong> be counted for that day.
                          </p>
                        </div>
                        <Toggle checked={systemSettings.strict_attendance_mode} onChange={v => setSystemSettings(s => ({ ...s, strict_attendance_mode: v }))} />
                      </div>
                      {systemSettings.strict_attendance_mode && (
                        <div className="p-3 bg-status-warning-bg/40 border border-status-warning/20 rounded-lg text-xs text-status-warning">
                          <strong>Strict Attendance Mode is active:</strong> Employees who forget to check out will have 0 working hours recorded and their attendance will be flagged as &quot;Missed Checkout&quot;.
                        </div>
                      )}
                      <div className="border-t border-slate-100 pt-4 mt-2">
                        <p className="text-sm font-medium text-slate-800 mb-2 flex items-center gap-1.5">Office Working Hours <InfoHint text="Defines the official workday window. Used to calculate lateness, early departures, and overtime eligibility." example="Start: 9:00 AM → an employee who checks in at 9:20 AM is marked 20 minutes late on their attendance record." /></p>
                        <p className="text-xs text-slate-500 mb-4 max-w-lg">
                          Configure the standard start and end times for the office. These times will be used to determine late check-ins, early leaves, and overtime calculations.
                        </p>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4">
                          <FieldRow label="Office Start Time" icon={Clock}>
                            <InputField
                              type="time"
                              value={systemSettings.office_start_time}
                              onChange={v => setSystemSettings(s => ({ ...s, office_start_time: v }))}
                            />
                          </FieldRow>
                          <FieldRow label="Office End Time" icon={Clock}>
                            <InputField
                              type="time"
                              value={systemSettings.office_end_time}
                              onChange={v => setSystemSettings(s => ({ ...s, office_end_time: v }))}
                            />
                          </FieldRow>
                        </div>
                      </div>

                      {/* ─ Lunch Break ─ */}
                      <div className="border-t border-slate-100 pt-4 mt-2">
                        <p className="text-sm font-medium text-slate-800 mb-2 flex items-center gap-1.5">Lunch Break <InfoHint text="The company-wide lunch break. The duration is automatically deducted from daily work hours on fixed shifts working more than 4 hours. No deduction for employees whose first check-in is at/after the lunch start time (afternoon/evening shifts), for flexible shifts, or on days with an explicitly tracked lunch session. Set duration to 0 to disable." example="Start 13:00, duration 60 → an employee working 09:00-18:00 is credited 8 hrs, while an evening-shift employee checking in at 14:00 gets no deduction." /></p>
                        <p className="text-xs text-slate-500 mb-4 max-w-lg">
                          Set when lunch starts and how long it lasts. The duration is deducted automatically from work hours, but employees who check in at or after the start time (e.g. evening shifts) are never deducted. Use <strong>0</strong> minutes to disable the deduction entirely.
                        </p>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4 items-start">
                          <FieldRow label="Lunch Start Time" icon={Clock}>
                            <InputField
                              type="time"
                              value={systemSettings.lunch_break_start}
                              onChange={v => setSystemSettings(s => ({ ...s, lunch_break_start: v }))}
                            />
                          </FieldRow>
                          <FieldRow label="Lunch Duration (minutes)" icon={Clock}>
                            <InputField
                              type="number"
                              min={0}
                              value={systemSettings.lunch_break_duration_minutes}
                              onChange={v => setSystemSettings(s => ({ ...s, lunch_break_duration_minutes: v }))}
                              placeholder="60"
                            />
                          </FieldRow>
                        </div>
                        {(() => {
                          const duration = parseInt(String(systemSettings.lunch_break_duration_minutes), 10);
                          const disabled = isNaN(duration) || duration <= 0;
                          return (
                            <div className={`mt-3 rounded-lg border px-3 py-2.5 text-xs ${disabled ? 'border-slate-200 bg-slate-50 text-slate-600' : 'border-brand-primary-light/30 bg-brand-primary-light/10 text-brand-primary'}`}>
                              {disabled
                                ? <>Lunch deduction is <strong>disabled</strong> — no time is deducted from anyone.</>
                                : <><strong>{duration} minutes</strong> are deducted after 4+ hours of work. Employees checking in at/after <strong>{systemSettings.lunch_break_start}</strong> get no deduction.</>}
                            </div>
                          );
                        })()}
                      </div>

                      {/* ─ Geofencing ─ */}
                      <div className="border-t border-slate-100 pt-4 mt-2">
                        <p className="text-sm font-medium text-slate-800 mb-2 flex items-center gap-1.5">Geofencing <InfoHint text="When enabled, employees must be physically within the configured radius of the office to check in (button and face recognition). Requires browser location permission. HR-triggered manual check-ins are exempt." example="Office at 13.0827,80.2707 with a 100m radius rejects check-in from an employee 300m away with an 'out of office' error." /></p>
                        <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-slate-50 rounded-lg mb-4">
                          <div>
                            <p className="text-sm font-medium text-slate-800">Require employees to be near the office to check in</p>
                            <p className="text-xs text-slate-500 mt-0.5 max-w-lg">
                              Employees will be asked for their device location when checking in, and check-in is rejected if they are outside the allowed radius.
                            </p>
                          </div>
                          <Toggle checked={systemSettings.geofencing_enabled} onChange={v => setSystemSettings(s => ({ ...s, geofencing_enabled: v }))} />
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 sm:gap-4 items-start">
                          <FieldRow label="Office Latitude" icon={MapPin}>
                            <InputField
                              type="number"
                              step="0.0000001"
                              value={systemSettings.office_latitude}
                              onChange={v => setSystemSettings(s => ({ ...s, office_latitude: v }))}
                              placeholder="13.0827"
                            />
                          </FieldRow>
                          <FieldRow label="Office Longitude" icon={MapPin}>
                            <InputField
                              type="number"
                              step="0.0000001"
                              value={systemSettings.office_longitude}
                              onChange={v => setSystemSettings(s => ({ ...s, office_longitude: v }))}
                              placeholder="80.2707"
                            />
                          </FieldRow>
                          <FieldRow label="Allowed Radius (meters)" icon={MapPin}>
                            <InputField
                              type="number"
                              min={1}
                              value={systemSettings.geofencing_radius_meters}
                              onChange={v => setSystemSettings(s => ({ ...s, geofencing_radius_meters: v }))}
                              placeholder="100"
                            />
                          </FieldRow>
                        </div>
                        {systemSettings.geofencing_enabled && (!systemSettings.office_latitude || !systemSettings.office_longitude) && (
                          <div className="mt-3 rounded-lg border border-status-warning/30 bg-status-warning-bg px-3 py-2.5 text-xs text-status-warning">
                            Set office latitude and longitude before saving, or check-in will fail for all employees.
                          </div>
                        )}
                      </div>

                      {/* ─ Attendance Day End Boundary ─ */}
                      <div className="border-t border-slate-100 pt-4 mt-2">
                        <p className="text-sm font-medium text-slate-800 mb-2 flex items-center gap-1.5">Attendance Day End <InfoHint text="The exact time the attendance day closes: no-shows are marked Absent and open sessions are auto-closed (Missed Checkout in strict mode). Times 12:00-23:59 close the day the same night; times 00:00-11:59 close it early the NEXT morning, so overnight work counts toward the previous day." example="Boundary 01:00 → an employee working until 00:45 has those hours credited to the previous day; the day flips at exactly 01:00 AM." /></p>
                        <p className="text-xs text-slate-500 mb-4 max-w-lg">
                          Set when the attendance day officially ends. Work past midnight up to this boundary is counted toward the previous day, and absent / missed-checkout marking happens exactly at this time.
                        </p>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4 items-start">
                          <FieldRow label="Day End Boundary" icon={Clock}>
                            <InputField
                              type="time"
                              value={systemSettings.attendance_day_end_time}
                              onChange={v => setSystemSettings(s => ({ ...s, attendance_day_end_time: v }))}
                            />
                          </FieldRow>
                          {(() => {
                            const [h = 23, m = 59] = systemSettings.attendance_day_end_time.split(':').map(Number);
                            const mins = (isNaN(h) ? 23 : h) * 60 + (isNaN(m) ? 59 : m);
                            const afterMidnight = mins < 720;
                            return (
                              <div className={`rounded-lg border px-3 py-2.5 text-xs ${afterMidnight ? 'border-brand-primary-light/30 bg-brand-primary-light/10 text-brand-primary' : 'border-slate-200 bg-slate-50 text-slate-600'}`}>
                                {afterMidnight
                                  ? <>Day closes at <strong>{systemSettings.attendance_day_end_time}</strong> the <strong>next morning</strong> — overnight hours count toward the previous day.</>
                                  : <>Day closes the <strong>same day</strong> at <strong>{systemSettings.attendance_day_end_time}</strong>.</>}
                              </div>
                            );
                          })()}
                        </div>
                        {(() => {
                          const [h = 23, m = 59] = systemSettings.attendance_day_end_time.split(':').map(Number);
                          const boundaryMins = (isNaN(h) ? 23 : h) * 60 + (isNaN(m) ? 59 : m);
                          const [eh = 17, em = 30] = systemSettings.office_end_time.split(':').map(Number);
                          const officeEndMins = (isNaN(eh) ? 17 : eh) * 60 + (isNaN(em) ? 30 : em);
                          return boundaryMins >= 720 && boundaryMins < officeEndMins ? (
                            <div className="mt-3 p-3 bg-status-warning-bg/40 border border-status-warning/20 rounded-lg text-xs text-status-warning">
                              <strong>Boundary falls inside office hours:</strong> sessions still open after {systemSettings.attendance_day_end_time} will be closed immediately by the system. Set the boundary after office end time (or after midnight) unless this is intended.
                            </div>
                          ) : null;
                        })()}
                      </div>

                      {/* ─ Monthly Attendance Request Limit ─ */}
                      <div className="border-t border-slate-100 pt-4 mt-2">
                        <p className="text-sm font-medium text-slate-800 mb-2 flex items-center gap-1.5">Monthly Attendance Request Limit <InfoHint text="Maximum number of attendance-correction requests an employee may submit per calendar month via self-service. Set to 0 for unlimited. Requests HR creates on an employee's behalf are exempt." example="Set to 3 → an employee who already submitted 3 requests this month is blocked from submitting a 4th and asked to contact HR." /></p>
                        <p className="text-xs text-slate-500 mb-4 max-w-lg">
                          Caps how many times an employee can request a forgotten check-in/check-out adjustment each month. Use <strong>0</strong> to allow unlimited requests.
                        </p>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4">
                          <FieldRow label="Requests per month" icon={Clock}>
                            <InputField
                              data-testid="setting-correction-limit"
                              type="number"
                              min={0}
                              value={systemSettings.monthly_attendance_request_limit}
                              onChange={v => setSystemSettings(s => ({ ...s, monthly_attendance_request_limit: v }))}
                              placeholder="3"
                            />
                          </FieldRow>
                        </div>
                      </div>

                      {/* ─ Company Timezone ─ */}
                      <div className="border-t border-slate-100 pt-4 mt-2">
                        <div className="flex items-center gap-2 mb-1">
                          <Globe className="h-4 w-4 text-brand-primary" />
                          <p className="text-sm font-medium text-slate-800 flex items-center gap-1.5">Company Timezone <InfoHint text="All attendance timestamps, scheduled report emails, and calendar events use this timezone." example="Set to Asia/Kolkata → a check-in at 9 AM by an employee in Delhi is recorded as 09:00 IST in all reports and exports." /></p>
                        </div>
                        <p className="text-xs text-slate-500 mb-4 max-w-lg">
                          Set the company's primary IANA timezone. Used for business rules (late/early check-in, office hours,
                          payroll boundaries). Remote employees can additionally set their own personal timezone in their profile.
                        </p>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4 items-start">
                          <div>
                            <label className="block text-xs font-medium text-slate-600 mb-1.5">Timezone</label>
                            <TimezoneSelect
                              value={systemSettings.system_timezone}
                              onChange={tz => setSystemSettings(s => ({ ...s, system_timezone: tz || 'Asia/Kolkata' }))}
                            />
                          </div>
                          <div className="flex flex-col gap-2">
                            <label className="block text-xs font-medium text-slate-600">Live Preview</label>
                            <div className="rounded-lg border border-brand-primary-light/30 bg-gradient-to-br from-brand-primary-light/10 to-slate-50 px-3 py-2.5 flex flex-col gap-1">
                              <span className="text-xs text-slate-500">Current time in selected timezone</span>
                              <LiveTZClock tz={systemSettings.system_timezone} />
                              <span className="text-xs font-medium text-brand-primary">
                                {utcOffsetLabel(systemSettings.system_timezone)} · {systemSettings.system_timezone.replace(/_/g, ' ')}
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </SectionCard>

                  {/* ─ Calendar & Scheduling ─ */}
                  <SectionCard title="Calendar & Scheduling" icon={Calendar} badge="Define weekly rest days and holidays">
                    <div className="flex flex-col gap-3">
                      <div>
                        <p className="text-sm font-medium text-slate-800 mb-2 flex items-center gap-1.5">Weekly Holidays <InfoHint text="Days of the week that are official non-working days. Employees are never marked absent on these days." example="Selecting Saturday & Sunday means weekend attendance is never required and no 'absent' is recorded." /></p>
                        <p className="text-xs text-slate-500 mb-3 max-w-lg">
                          Company default weekly off days. Individual branches can override this in their own settings (e.g. Fri &amp; Sat for a Gulf branch). Calendar shading, attendance, leave and payroll all adapt dynamically.
                        </p>
                        <div className="flex flex-wrap gap-2.5">
                          {[
                            { value: '0', label: 'Sunday' },
                            { value: '1', label: 'Monday' },
                            { value: '2', label: 'Tuesday' },
                            { value: '3', label: 'Wednesday' },
                            { value: '4', label: 'Thursday' },
                            { value: '5', label: 'Friday' },
                            { value: '6', label: 'Saturday' },
                          ].map((day) => {
                            const holidays = (systemSettings.calendar_weekly_holidays || '0').split(',');
                            const isChecked = holidays.includes(day.value);

                            const handleToggle = () => {
                              let newHolidays;
                              if (isChecked) {
                                newHolidays = holidays.filter(h => h !== day.value);
                              } else {
                                newHolidays = [...holidays, day.value];
                              }
                              const sortedHolidays = newHolidays.sort().join(',');
                              setSystemSettings(s => ({ ...s, calendar_weekly_holidays: sortedHolidays || '' }));
                            };

                            return (
                              <button
                                key={day.value}
                                type="button"
                                onClick={handleToggle}
                                className={`px-3 py-1.5 text-xs rounded-lg border transition-all font-medium ${isChecked
                                    ? 'border-brand-primary bg-brand-primary-light/10 text-brand-primary shadow-xs'
                                    : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                                  }`}
                              >
                                {day.label}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      <div className="border-t border-slate-100 pt-4 mt-2">
                        <p className="text-sm font-medium text-slate-800 mb-2 flex items-center gap-1.5">Shift Notification Reminders <InfoHint text="Controls when employees receive shift alerts relative to shift start and end times." example="Prior 15 → reminder sent at 8:45 AM for a 9:00 AM shift. Post 10 → checkout reminder at 6:10 PM for a 6:00 PM shift end." /></p>
                        <p className="text-xs text-slate-500 mb-4 max-w-lg">
                          Configure when employees should receive shift alerts. These values determine how many minutes before and after the shift start an alert is sent.
                        </p>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4">
                          <FieldRow label="Prior Reminder Offset (Minutes)" icon={Bell} hint={<InfoHint text="Minutes before shift start when employees receive a check-in reminder." example="Prior: 15 → reminder notification sent at 8:45 AM for a 9:00 AM shift start." />}>
                            <InputField
                              type="number"
                              value={systemSettings.shift_reminder_prior_mins}
                              onChange={v => setSystemSettings(s => ({ ...s, shift_reminder_prior_mins: v }))}
                              placeholder="5"
                            />
                          </FieldRow>
                          <FieldRow label="Post-Start Alert Offset (Minutes)" icon={Clock} hint={<InfoHint text="Minutes after shift end when employees receive a check-out reminder." example="Post: 10 → checkout reminder sent at 6:10 PM for a 6:00 PM shift end." />}>
                            <InputField
                              type="number"
                              value={systemSettings.shift_reminder_post_mins}
                              onChange={v => setSystemSettings(s => ({ ...s, shift_reminder_post_mins: v }))}
                              placeholder="5"
                            />
                          </FieldRow>
                        </div>
                      </div>

                      <div className="border-t border-slate-100 pt-4 mt-2">
                        <p className="text-sm font-medium text-slate-800 mb-2 flex items-center gap-1.5">Visa Expiry Reminders <InfoHint text="How many days before a visa expires the system starts alerting HR and the employee (email + in-app)." example="30 → a visa expiring on Aug 15 triggers alerts from Jul 16 onward. Each visa alerts once." /></p>
                        <p className="text-xs text-slate-500 mb-4 max-w-lg">
                          Days before visa expiry to send reminder alerts to Admins, HR Managers and the employee.
                        </p>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4">
                          <FieldRow label="Reminder Period (Days)" icon={Bell} hint={<InfoHint text="Days before the visa expiry date when reminder alerts are sent." example="30 → alerts begin 30 days before expiry." />}>
                            <InputField
                              type="number"
                              value={systemSettings.visa_expiry_alert_days}
                              onChange={v => setSystemSettings(s => ({ ...s, visa_expiry_alert_days: v }))}
                              placeholder="30"
                            />
                          </FieldRow>
                        </div>
                      </div>
                    </div>
                  </SectionCard>

                  {/* ─ Email SMTP ─ developer only. The System Settings tab stays
                      visible to admins; only this card and the two maintenance
                      cards below are operator-owned, so the gate is per section
                      rather than per tab. The backend strips the mail_* keys
                      from GET /system-settings unless elevated, so an unelevated
                      admin could not populate this form even if it rendered. */}
                  {devElevated && (
                  <SectionCard title="Email SMTP Configuration" icon={Mail} badge="Transactional email settings" collapsible>
                    <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-slate-50 rounded-lg">
                      <div>
                        <p className="text-xs font-medium text-slate-700 flex items-center gap-1.5">Enable Email Service <InfoHint text="Activates the SMTP email delivery system for all notifications, reports, and alerts." example="When enabled, leave approvals, attendance reports, and payroll slips are sent via your own SMTP server." /></p>
                        <p className="text-xs text-slate-500">Toggle whether the system sends automated emails</p>
                      </div>
                      <Toggle checked={systemSettings.mail_enabled} onChange={v => setSystemSettings(s => ({ ...s, mail_enabled: v }))} />
                    </div>
                    {systemSettings.mail_enabled && (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4">
                        <FieldRow label="SMTP Host" icon={Server} hint={<InfoHint text="The outgoing mail server hostname provided by your email provider." example="Gmail: smtp.gmail.com · Outlook: smtp.office365.com · AWS SES: email-smtp.us-east-1.amazonaws.com" />}><InputField value={systemSettings.mail_host} onChange={v => setSystemSettings(s => ({ ...s, mail_host: v }))} placeholder="smtp.gmail.com" /></FieldRow>
                        <FieldRow label="SMTP Port" icon={Hash} hint={<InfoHint text="The port your mail server uses. 587 (TLS/STARTTLS) is the standard secure choice; 465 uses SSL; 25 is unencrypted." example="Port 587 with STARTTLS is recommended for most providers including Gmail and Outlook." />}><InputField value={systemSettings.mail_port} onChange={v => setSystemSettings(s => ({ ...s, mail_port: v }))} placeholder="587" /></FieldRow>
                        <FieldRow label="SMTP User" icon={User} hint={<InfoHint text="The email address or account username used to authenticate with your SMTP server." example="For Gmail: your full email address (e.g. hr@company.com). For AWS SES: an IAM access key ID." />}><InputField value={systemSettings.mail_user} onChange={v => setSystemSettings(s => ({ ...s, mail_user: v }))} placeholder="user@company.com" /></FieldRow>
                        <FieldRow label="SMTP Password" icon={Lock}><InputField value={systemSettings.mail_password} onChange={v => setSystemSettings(s => ({ ...s, mail_password: v }))} type="password" placeholder="App password" /></FieldRow>
                        <FieldRow label="Mail From Address" icon={Mail} hint={<InfoHint text="The email address that appears in the 'From' field of all system emails sent to employees." example="hr@thereciprocalsolutions.com → employees see this as the sender of all automated emails." />}><InputField value={systemSettings.mail_from} onChange={v => setSystemSettings(s => ({ ...s, mail_from: v }))} placeholder="noreply@company.com" /></FieldRow>
                        <FieldRow label="Mail From Name" icon={Tag} hint={<InfoHint text="The display name shown in email clients alongside the From address." example="'HR Department' → employees see 'HR Department <hr@company.com>' as the sender." />}><InputField value={systemSettings.mail_from_name} onChange={v => setSystemSettings(s => ({ ...s, mail_from_name: v }))} placeholder="HR Department" /></FieldRow>
                        <FieldRow label="BCC Email Address" icon={Mail} hint={<InfoHint text="A hidden recipient added to every outgoing system email, useful for auditing or archiving." example="bcc-archive@company.com → every email (leave approvals, payslips, reports) is silently copied here." />}><InputField value={systemSettings.mail_bcc} onChange={v => setSystemSettings(s => ({ ...s, mail_bcc: v }))} placeholder="bcc@company.com" /></FieldRow>
                      </div>
                    )}
                  </SectionCard>
                  )}

                  {/* ─ Task Management ─ */}
                  <SectionCard title="Task Management" icon={ListTodo} badge="Global task tracking behavior">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4">
                      <FieldRow label="Task Assignment List Mode" icon={ListTodo} hint={<InfoHint text="Controls which employees appear in the assignee dropdown when creating or editing a task." example="Set to 'Department Only' → a Marketing manager can only assign tasks to Marketing team members, not the whole company." />}>
                        <select
                          value={systemSettings.task_assignment_list_mode}
                          onChange={e => setSystemSettings(s => ({ ...s, task_assignment_list_mode: e.target.value }))}
                          className="w-full h-10 px-3 border border-slate-200 rounded-lg focus:outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/30 transition-all text-sm bg-white"
                        >
                          <option value="all">List All Employees</option>
                          <option value="department">List Department Employees Only</option>
                        </select>
                      </FieldRow>
                    </div>
                  </SectionCard>

                  {/* ─ Leave Management ─ */}
                  <SectionCard title="Leave Management" icon={Calendar} badge="Leave rules and approval workflow">
                    <div className="flex flex-col gap-3">
                      <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-slate-50 rounded-lg">
                        <div>
                          <p className="text-sm font-medium text-slate-800 flex items-center gap-1.5">Enable Multi-Tier Leave Approval Hierarchy <InfoHint text="When enabled, leave requests pass through multiple approval levels before being granted. Each level must approve sequentially." example="Employee submits leave → Team Lead approves first → HR gives final approval. If Team Lead rejects, the request never reaches HR." /></p>
                          <p className="text-xs text-slate-500 mt-0.5 max-w-lg">
                            When enabled, leave requests must be approved sequentially by the Department Head (MANAGER), the HR Manager (HR_MANAGER), and the Admin (ADMIN) in that order. When disabled, any single approver can approve directly.
                          </p>
                        </div>
                        <Toggle
                          checked={systemSettings.leave_approval_hierarchy_enabled}
                          onChange={v => setSystemSettings(s => ({ ...s, leave_approval_hierarchy_enabled: v }))}
                        />
                      </div>
                    </div>
                  </SectionCard>

                  {/* ─ Employee Management ─ */}
                  <SectionCard title="Employee Management" icon={User} badge="Data retention and deletion policies">
                    <div className="flex flex-col gap-3">
                      <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-slate-50 rounded-lg">
                        <div>
                          <p className="text-sm font-medium text-slate-800 flex items-center gap-1.5">Allow Hard Delete of Terminated Employees <InfoHint text="Permanently erases all data for terminated employees. When off, employees are soft-deleted (hidden but recoverable by an admin)." example="Hard delete ON: all payroll, attendance, and contract records are wiped and cannot be restored. Off: records are archived and can be reinstated." /></p>
                          <p className="text-xs text-slate-500 mt-0.5 max-w-lg">
                            When enabled, ADMIN and HR Manager can permanently remove a terminated employee and all their data from the database. This action is <strong>irreversible</strong> — all records including attendance, payroll, and documents will be deleted.
                          </p>
                        </div>
                        <Toggle
                          checked={systemSettings.allow_hard_delete_terminated}
                          onChange={v => setSystemSettings(s => ({ ...s, allow_hard_delete_terminated: v }))}
                        />
                      </div>
                      {systemSettings.allow_hard_delete_terminated && (
                        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
                          <strong>Hard delete is enabled:</strong> ADMIN and HR Manager can now permanently delete terminated employees from the database. This will erase all associated records and cannot be undone.
                        </div>
                      )}
                    </div>
                  </SectionCard>

                  {/* ─ Sample / Demo Data ─ developer only. Harmless on a demo
                      box, catastrophic on a live tenant. */}
                  {devElevated && (
                  <SectionCard title="Sample / Demo Data" icon={Database} badge="Populate the app to explore it end-to-end">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-3 py-2.5 bg-slate-50 rounded-lg">
                      <div>
                        <p className="text-sm font-medium text-slate-800">Load sample data</p>
                        <p className="text-xs text-slate-500 mt-0.5 max-w-lg">
                          Creates a realistic demo company — ~18 employees across 3 branches &amp; 6 departments, a full previous-month attendance &amp; shift calendar, leave &amp; overtime requests, reimbursements, advances/loans, a draft payroll, and sample projects with tasks. Re-running refreshes the sample data. Your system settings are untouched.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setSeedPhase('confirm')}
                        className="shrink-0 inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-lg bg-brand-primary hover:bg-brand-primary-dark"
                      >
                        <Sparkles size={15} /> Load sample data
                      </button>
                    </div>
                  </SectionCard>
                  )}

                  {/* Sample data flow modal (confirm → running → done/error) */}
                  {seedPhase !== 'idle' && (
                    <div
                      className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50"
                      onClick={() => { if (seedPhase !== 'running') setSeedPhase('idle'); }}
                    >
                      <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full border border-slate-200 overflow-hidden" onClick={e => e.stopPropagation()}>
                        <div className="flex items-start gap-3 p-5 border-b border-slate-100">
                          <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${seedPhase === 'error' ? 'bg-red-100 text-red-600' : seedPhase === 'done' ? 'bg-green-100 text-green-600' : 'bg-brand-primary/10 text-brand-primary'}`}>
                            {seedPhase === 'running' ? <Loader2 size={20} className="animate-spin" /> : seedPhase === 'done' ? <CheckCircle2 size={20} /> : seedPhase === 'error' ? <AlertTriangle size={20} /> : <Sparkles size={20} />}
                          </div>
                          <div className="min-w-0">
                            <h3 className="text-base font-semibold text-slate-800">
                              {seedPhase === 'confirm' && 'Load sample data?'}
                              {seedPhase === 'running' && 'Loading sample data…'}
                              {seedPhase === 'done' && 'Sample data ready 🎉'}
                              {seedPhase === 'error' && 'Sample data failed'}
                            </h3>
                            <p className="text-xs text-slate-500 mt-1">
                              {seedPhase === 'confirm' && 'This creates a realistic demo company so you can explore every module. If sample data already exists, it will be refreshed. Your system settings are not changed.'}
                              {seedPhase === 'running' && 'Please keep this dialog open while we set everything up — this takes a few seconds.'}
                              {seedPhase === 'done' && 'You can now browse employees, attendance, payroll, projects and more with realistic data.'}
                              {seedPhase === 'error' && 'Something went wrong while seeding. You can safely try again.'}
                            </p>
                          </div>
                          {seedPhase !== 'running' && (
                            <button
                              type="button"
                              onClick={() => setSeedPhase('idle')}
                              className="ms-auto -mt-1 -me-1 p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 shrink-0"
                              aria-label="Dismiss"
                            >
                              <X size={16} />
                            </button>
                          )}
                        </div>

                        {seedPhase === 'confirm' && (
                          <div className="p-5 pt-4 flex justify-end gap-2">
                            <button type="button" onClick={() => setSeedPhase('idle')} className="px-4 py-2 text-sm rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">Cancel</button>
                            <button type="button" onClick={startSeeding} className="px-4 py-2 text-sm text-white rounded-lg bg-brand-primary hover:bg-brand-primary-dark inline-flex items-center gap-2"><Sparkles size={15} /> Load sample data</button>
                          </div>
                        )}

                        {(seedPhase === 'running' || seedPhase === 'done') && (
                          <div className="p-5">
                            {(() => {
                              const last = seedLogs[seedLogs.length - 1];
                              const total = last?.total || 15;
                              const cur = seedPhase === 'done' ? total : (last?.step || 0);
                              const pct = Math.round((cur / total) * 100);
                              return (
                                <div className="mb-4">
                                  <div className="flex items-center justify-between text-[11px] font-medium text-slate-500 mb-1.5">
                                    <span>{seedPhase === 'done' ? 'Completed' : `Step ${cur} of ${total}`}</span>
                                    <span>{pct}%</span>
                                  </div>
                                  <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
                                    <div className="h-full bg-brand-primary transition-all duration-500 ease-out" style={{ width: `${pct}%` }} />
                                  </div>
                                </div>
                              );
                            })()}

                            {seedPhase === 'running' && (
                              <>
                                {/* Current status — updates in place (fixed height, no growth) */}
                                <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-brand-primary/5 border border-brand-primary/10">
                                  <Loader2 size={16} className="animate-spin text-brand-primary shrink-0" />
                                  <span className="text-sm font-medium text-slate-800 truncate">
                                    {seedLogs[seedLogs.length - 1]?.message || 'Starting…'}
                                  </span>
                                </div>
                                {/* Completed steps — fixed-height scroller keeps the popup size stable */}
                                <div ref={seedLogRef} className="mt-3 h-32 overflow-y-auto rounded-lg border border-slate-100 bg-slate-50/60 p-2.5 space-y-1">
                                  {seedLogs.slice(0, -1).map((l, i) => (
                                    <div key={i} className="flex items-center gap-2 text-xs text-slate-500">
                                      <CheckCircle2 size={12} className="text-green-500 shrink-0" />
                                      <span className="truncate">{l.message}</span>
                                    </div>
                                  ))}
                                  {seedLogs.length <= 1 && <div className="text-xs text-slate-400 px-0.5">Preparing…</div>}
                                </div>
                              </>
                            )}

                            {seedPhase === 'done' && (
                              <div>
                                <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-green-50 border border-green-100 mb-3">
                                  <CheckCircle2 size={16} className="text-green-600 shrink-0" />
                                  <span className="text-sm font-medium text-green-800">Sample data created successfully</span>
                                </div>
                                {seedSummary && (
                                  <>
                                    <p className="text-xs font-medium text-slate-600 mb-2">Created</p>
                                    <div className="grid grid-cols-3 gap-2">
                                      {Object.entries(seedSummary).map(([k, v]) => (
                                        <div key={k} className="rounded-lg border border-slate-100 bg-white px-2.5 py-2 text-center">
                                          <div className="text-base font-semibold text-slate-800">{v as number}</div>
                                          <div className="text-[10px] text-slate-400 capitalize truncate">{k.replace(/([A-Z])/g, ' $1')}</div>
                                        </div>
                                      ))}
                                    </div>
                                  </>
                                )}
                              </div>
                            )}

                            <div className="mt-4 flex justify-end">
                              <button type="button" disabled={seedPhase === 'running'} onClick={() => setSeedPhase('idle')}
                                className="px-4 py-2 text-sm text-white rounded-lg bg-brand-primary hover:bg-brand-primary-dark disabled:opacity-50">
                                {seedPhase === 'running' ? 'Please wait…' : 'Done'}
                              </button>
                            </div>
                          </div>
                        )}

                        {seedPhase === 'error' && (
                          <div className="p-5">
                            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700 break-words">{seedError}</div>
                            <div className="mt-4 flex justify-end gap-2">
                              <button type="button" onClick={() => setSeedPhase('idle')} className="px-4 py-2 text-sm rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">Close</button>
                              <button type="button" onClick={startSeeding} className="px-4 py-2 text-sm text-white rounded-lg bg-brand-primary hover:bg-brand-primary-dark">Try again</button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* ─ Danger Zone ─ developer only. Wiping a live tenant is an
                      operator action, never a customer-admin one. */}
                  {devElevated && (
                  <SectionCard title="Danger Zone" icon={AlertTriangle} badge="Irreversible maintenance actions">
                    <div className="flex flex-col gap-3">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-3 py-2.5 bg-slate-50 rounded-lg">
                        <div>
                          <p className="text-sm font-medium text-slate-800">Reset database to baseline</p>
                          <p className="text-xs text-slate-500 mt-0.5 max-w-lg">
                            Permanently deletes <strong>all</strong> employees, users, attendance, payroll, leave, overtime, reimbursements, advances, projects and tasks — then restores only the base <strong>admin</strong>, <strong>HR</strong> and <strong>employee</strong> accounts, the <strong>HRD</strong> department, and an active <strong>Head Office</strong> branch. System settings, libraries and holidays are kept.
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => { setResetPhrase(''); setShowResetModal(true); }}
                          className="shrink-0 inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-lg bg-status-error hover:opacity-90"
                        >
                          <RotateCcw size={15} /> Reset database
                        </button>
                      </div>
                      <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
                        <strong>Warning:</strong> This cannot be undone. You (and everyone signed in) will be logged out and must sign in again with a base account.
                      </div>
                    </div>
                  </SectionCard>
                  )}

                  {/* Reset confirmation (type-to-confirm) */}
                  {showResetModal && (
                    <div
                      className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50"
                      onClick={() => !resetting && setShowResetModal(false)}
                    >
                      <div
                        className="bg-white rounded-2xl shadow-2xl max-w-md w-full border border-slate-200"
                        onClick={e => e.stopPropagation()}
                      >
                        <div className="flex items-start gap-3 p-5 border-b border-slate-100">
                          <div className="w-10 h-10 rounded-lg bg-red-100 text-red-600 flex items-center justify-center shrink-0">
                            <AlertTriangle size={20} />
                          </div>
                          <div>
                            <h3 className="text-base font-semibold text-slate-800">Reset database to baseline?</h3>
                            <p className="text-xs text-slate-500 mt-1">
                              This permanently deletes all operational data (keeping only system settings and libraries) and restores the three base accounts and Head Office. This action cannot be undone.
                            </p>
                          </div>
                        </div>
                        <div className="p-5 space-y-2">
                          <label className="text-xs font-medium text-slate-600">
                            Type <span className="font-mono text-red-600 font-semibold">RESET</span> to confirm
                          </label>
                          <input
                            autoFocus
                            value={resetPhrase}
                            onChange={e => setResetPhrase(e.target.value)}
                            placeholder="RESET"
                            className="w-full h-10 px-3 border border-slate-200 rounded-lg focus:outline-none focus:border-red-400 focus:ring-2 focus:ring-red-200 text-sm"
                          />
                        </div>
                        <div className="flex justify-end gap-2 p-5 pt-0">
                          <button
                            type="button"
                            disabled={resetting}
                            onClick={() => setShowResetModal(false)}
                            className="px-4 py-2 text-sm rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            disabled={resetPhrase.trim() !== 'RESET' || resetting}
                            onClick={handleResetDatabase}
                            className="px-4 py-2 text-sm text-white rounded-lg bg-status-error hover:opacity-90 disabled:opacity-50"
                          >
                            {resetting ? 'Resetting…' : 'Reset database'}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* ── Payroll Settings ── */}
              {activeTab === 'payroll' && user?.role === 'ADMIN' && (
                <div className="space-y-4 sm:space-y-5">
                  {/* Header card */}
                  <div className="surface-panel p-4 sm:p-5">
                    <h2 className="text-sm sm:text-base font-semibold text-text-heading mb-0.5">Payroll Settings</h2>
                    <p className="text-xs text-slate-500">Configure global payroll rules, country presets, statutory compliance, tax brackets, and social contribution rates</p>
                  </div>

                  <PayrollFeatureSwitches
                    values={featureFlags}
                    onChange={setFeatureFlag}
                  />

                  {/* Country Preset Grid */}
                  <div className="bg-gradient-to-br from-brand-primary/5 via-white to-indigo-50 rounded-xl border border-brand-primary/20 p-4 sm:p-5">
                    <div className="flex items-center gap-3 mb-4">
                      <div className="w-8 h-8 bg-brand-primary rounded-lg flex items-center justify-center">
                        <Globe size={16} className="text-white" />
                      </div>
                      <div>
                        <h3 className="text-sm sm:text-base font-semibold text-slate-800">Country Payroll Preset</h3>
                        <p className="text-xs text-slate-500">Apply pre-configured statutory defaults for any country. All fields below will be updated — you can customise afterwards.</p>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
                      {PRESET_ORDER.map(code => {
                        const meta = COUNTRY_META[code];
                        const isActive = payroll.payroll_country === code;
                        const isCustomMode = code === 'CUSTOM';
                        return (
                          <button
                            key={code}
                            id={`preset-${code.toLowerCase()}`}
                            onClick={() => handleApplyPreset(code)}
                            disabled={applyingPreset}
                            className={`group relative flex flex-col items-start gap-1.5 px-3 py-3 rounded-xl border-2 transition-all text-sm shadow-sm hover:shadow-md disabled:opacity-60 text-left ${isCustomMode
                              ? isActive
                                ? 'border-status-warning bg-status-warning-bg/30 text-status-warning'
                                : 'border-dashed border-slate-300 bg-slate-50 text-slate-500 hover:border-status-warning/45 hover:bg-status-warning-bg/30'
                              : isActive
                                ? 'border-brand-primary bg-brand-primary/5 text-brand-primary'
                                : 'border-slate-200 bg-white text-slate-700 hover:border-brand-primary/40'
                              }`}
                          >
                            <span className="text-xl leading-none">{meta.flag}</span>
                            <div>
                              <p className="font-semibold text-sm leading-tight">{meta.name}</p>
                              <p className="text-xs font-normal opacity-70 mt-0.5 leading-tight">{meta.tag}</p>
                            </div>
                            {isActive && !isCustomMode && (
                              <CheckCircle2 size={14} className="text-brand-primary absolute top-2 right-2" />
                            )}
                            {isActive && isCustomMode && (
                              <CheckCircle2 size={14} className="text-status-warning absolute top-2 right-2" />
                            )}
                            {presetApplied === code && (
                              <span className="absolute -top-2 -right-2 bg-status-success text-text-on-brand text-xs px-2 py-0.5 rounded-full">Applied!</span>
                            )}
                          </button>
                        );
                      })}
                    </div>

                    <div className="flex items-start gap-2 mt-4 p-3 bg-status-info-bg rounded-lg">
                      <Info size={14} className="text-brand-primary flex-shrink-0 mt-0.5" />
                      <p className="text-xs text-status-info">Applying a preset will reset <strong>all payroll settings</strong> to that country's statutory defaults. All fields remain fully editable after applying.</p>
                    </div>

                    {payroll.payroll_country === 'CUSTOM' && (
                      <div className="flex items-start gap-2 mt-3 p-3 bg-status-warning-bg/40 border border-status-warning/20 rounded-lg">
                        <Info size={14} className="text-text-muted flex-shrink-0 mt-0.5" />
                        <p className="text-xs text-status-warning">You are in <strong>Custom mode</strong>. All fields are blank and fully editable. Configure each section below to match your country's payroll rules.</p>
                      </div>
                    )}
                  </div>

                  {/* ─ Component Labels ─ */}
                  <SectionCard title="Component Labels" icon={Edit3} badge="Rename every section title and field label to match your country's terminology" collapsible>
                    <div className="space-y-4">
                      {/* Header row */}
                      <div className="flex items-center justify-between">
                        <p className="text-xs text-slate-500">
                          Rename each component to match your local payroll terminology. Leave blank to use the country-preset default (shown as placeholder).
                        </p>
                        <button
                          id="reset-labels-btn"
                          onClick={() => setCustomLabels(EMPTY_LABELS)}
                          className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-status-error hover:bg-status-error-bg/30 px-3 py-1.5 rounded-lg border border-slate-200 hover:border-status-error/30 transition-all font-medium"
                        >
                          <RotateCcw size={12} />
                          Reset all to defaults
                        </button>
                      </div>

                      {/* Grouped table */}
                      {(['Section title', 'PF field', 'ESI field'] as const).map(category => {
                        const entries = LABEL_ENTRIES.filter(e => e.category === category);
                        return (
                          <div key={category}>
                            <div className="flex items-center gap-2 mb-2">
                              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${category === 'Section title' ? 'bg-brand-primary/10 text-brand-primary' :
                                category === 'PF field' ? 'bg-status-success-bg text-status-success' :
                                  'bg-brand-accent/10 text-brand-accent-dark'
                                }`}>{category}s</span>
                            </div>
                            <div className="rounded-xl border border-slate-200 overflow-x-auto">
                              <table className="w-full text-sm">
                                <thead className="bg-slate-50">
                                  <tr>
                                    <th className="px-3 py-2.5 text-left text-[11px] font-medium text-slate-500 uppercase tracking-wide w-[38%]">Setting / Component</th>
                                    <th className="px-3 py-2.5 text-left text-[11px] font-medium text-slate-500 uppercase tracking-wide w-[25%] hidden sm:table-cell">Country Default</th>
                                    <th className="px-3 py-2.5 text-left text-[11px] font-medium text-slate-500 uppercase tracking-wide">Custom Name</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100">
                                  {entries.map(entry => {
                                    const defaultLabel = entry.getDefault(countryMeta);
                                    const customVal = customLabels[entry.key];
                                    return (
                                      <tr key={entry.key} className={`hover:bg-slate-50 transition-colors ${customVal ? 'bg-brand-primary-light/10' : ''}`}>
                                        <td className="px-3 py-2.5">
                                          <p className="text-xs font-medium text-slate-700 leading-tight">{entry.description}</p>
                                          <p className="text-xs text-slate-400 font-mono mt-0.5 hidden md:block">{entry.key}</p>
                                        </td>
                                        <td className="px-3 py-2.5 hidden sm:table-cell">
                                          <span className="text-xs text-slate-400 italic">{defaultLabel}</span>
                                        </td>
                                        <td className="px-3 py-2.5">
                                          <div className="relative">
                                            <input
                                              type="text"
                                              value={customVal}
                                              placeholder={defaultLabel}
                                              onChange={e => setCustomLabels(prev => ({ ...prev, [entry.key]: e.target.value }))}
                                              className={`w-full px-3 py-1.5 border rounded-lg text-sm focus:outline-none transition-all ${customVal
                                                ? 'border-brand-primary/50 bg-white focus:border-brand-primary ring-1 ring-brand-primary/20'
                                                : 'border-slate-200 bg-white focus:border-brand-primary'
                                                }`}
                                            />
                                            {customVal && (
                                              <button
                                                onClick={() => setCustomLabels(prev => ({ ...prev, [entry.key]: '' }))}
                                                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-status-error transition-colors"
                                                title="Clear custom label"
                                              >
                                                ✕
                                              </button>
                                            )}
                                          </div>
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        );
                      })}

                      <div className="flex items-start gap-2 p-3 bg-status-info-bg rounded-lg">
                        <Info size={13} className="text-brand-primary flex-shrink-0 mt-0.5" />
                        <p className="text-xs text-status-info">
                          Custom names apply immediately in the sections below and on all payslips. <strong>Highlighted rows</strong> have an active override. Applying a country preset resets all labels to that country's defaults.
                        </p>
                      </div>
                    </div>
                  </SectionCard>

                  {/* ─ General Payroll ─ */}
                  <SectionCard title={getLabel('payroll_label_general')} icon={CurrencyIcon} badge="Currency · Work hours · Overtime">
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
                      <FieldRow label="Currency Code" icon={CurrencyIcon}>
                        <InputField value={payroll.payroll_currency} onChange={v => setPayroll(p => ({ ...p, payroll_currency: v }))} placeholder="INR" />
                      </FieldRow>
                      <FieldRow label="Currency Symbol">
                        <InputField value={payroll.payroll_currency_symbol} onChange={v => setPayroll(p => ({ ...p, payroll_currency_symbol: v }))} placeholder="₹" />
                      </FieldRow>
                      <FieldRow label="Amount Display" hint={<InfoHint text="How money renders everywhere in the app — using the currency symbol or the ISO currency code. Applies site-wide after saving." example="Symbol → ₹1,234 · د.إ1,234.  Code → INR 1,234 · OMR 1,234." />}>
                        <select
                          value={payroll.payroll_currency_display || 'symbol'}
                          onChange={e => setPayroll(p => ({ ...p, payroll_currency_display: e.target.value }))}
                          className="w-full h-10 px-3 border border-slate-200 rounded-lg focus:outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/30 transition-all text-sm bg-white">
                          <option value="symbol">Symbol{payroll.payroll_currency_symbol ? ` (${payroll.payroll_currency_symbol}1,234)` : ' (₹1,234)'}</option>
                          <option value="code">Code{payroll.payroll_currency ? ` (${payroll.payroll_currency} 1,234)` : ' (INR 1,234)'}</option>
                        </select>
                      </FieldRow>
                      <FieldRow label="Country Code">
                        <InputField value={payroll.payroll_country} onChange={v => setPayroll(p => ({ ...p, payroll_country: v }))} placeholder="IN" />
                      </FieldRow>
                      <FieldRow label="Work Hours / Day" icon={Clock} hint={<InfoHint text="Standard number of working hours in a day, used to derive the hourly rate. A monthly salary is divided by the month's work days and then by these hours; a daily rate is divided by these hours alone." example="₹30,000/month ÷ 26 days ÷ 8 hrs = ₹144/hr. A daily-wage employee on ₹800/day ÷ 8 hrs = ₹100/hr." />}>
                        <InputField value={payroll.payroll_work_hours_per_day} onChange={v => setPayroll(p => ({ ...p, payroll_work_hours_per_day: v }))} type="number" placeholder="8" />
                      </FieldRow>
                      <FieldRow label="Work Days / Week" hint={<InfoHint text="Number of working days in a week, used to calculate monthly working days and pro-rated salaries." example="5 days/week → ~22 working days/month. A new joiner on the 15th gets ~8 days of pro-rated pay." />}>
                        <select value={payroll.payroll_work_days_per_week} onChange={e => setPayroll(p => ({ ...p, payroll_work_days_per_week: e.target.value }))}
                          className="w-full h-10 px-3 border border-slate-200 rounded-lg focus:outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/30 transition-all text-sm bg-white">
                          <option value="5">5 days (Mon–Fri)</option>
                          <option value="6">6 days (Mon–Sat)</option>
                        </select>
                      </FieldRow>
                      <FieldRow label="Overtime Multiplier" icon={TrendingUp} hint={<InfoHint text="Factor applied to the employee's hourly rate for overtime hours in the monthly payroll calculation." example="Hourly rate ₹500 × OT multiplier 1.5 = ₹750 per overtime hour on the payslip." />}>
                        <InputField value={payroll.payroll_overtime_rate} onChange={v => setPayroll(p => ({ ...p, payroll_overtime_rate: v }))} type="number" placeholder="1.5" />
                      </FieldRow>
                      <FieldRow label="Basic Salary % of CTC" hint={<InfoHint text="Percentage of total CTC treated as Basic Salary. PF, gratuity, and many allowances are calculated from this base." example="CTC ₹10L/year with 40% basic → Basic = ₹4L. PF is then 12% of ₹4L = ₹48,000/year." />}>
                        <InputField value={payroll.payroll_basic_salary_percentage} onChange={v => setPayroll(p => ({ ...p, payroll_basic_salary_percentage: v }))} type="number" placeholder="40" />
                      </FieldRow>
                    </div>
                  </SectionCard>

                  {/* ─ Social Insurance / PF ─ */}
                  <SectionCard title={getLabel('payroll_label_pf')} icon={Building2} badge="Social insurance / retirement contribution" collapsible>
                    <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-slate-50 rounded-lg">
                      <div>
                        <p className="text-sm font-medium text-slate-800 flex items-center gap-1.5">Enable {getLabel('payroll_label_pf')} <InfoHint text="Activates mandatory provident fund contributions — deducted from the employee and matched (or contributed) by the employer each month." example="12% employee + 12% employer on ₹15,000 basic → ₹1,800 deducted from employee, ₹1,800 contributed by company." /></p>
                        <p className="text-xs text-slate-500">Mandatory social/provident fund deduction from employee salary</p>
                      </div>
                      <Toggle checked={payroll.payroll_pf_enabled} onChange={v => setPayroll(p => ({ ...p, payroll_pf_enabled: v }))} />
                    </div>
                    {payroll.payroll_pf_enabled && (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4">
                        <FieldRow label={getLabel('payroll_label_pf_employee_rate')} icon={Percent} hint={<InfoHint text="Percentage of Basic Salary deducted from the employee's gross pay each month for Provident Fund." example="Rate 12% on ₹15,000 basic → ₹1,800 deducted from employee's salary each month." />}>
                          <div className="relative">
                            <InputField value={String(Number(payroll.payroll_pf_employee_rate) * 100)} onChange={v => setPayroll(p => ({ ...p, payroll_pf_employee_rate: String(Number(v) / 100) }))} type="number" placeholder="12" />
                            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 text-sm">%</span>
                          </div>
                        </FieldRow>
                        <FieldRow label={getLabel('payroll_label_pf_employer_rate')} icon={Percent} hint={<InfoHint text="Percentage of Basic Salary the company contributes to the employee's Provident Fund account." example="Employer rate 12% on ₹15,000 basic → company adds ₹1,800/month to the employee's PF account." />}>
                          <div className="relative">
                            <InputField value={String(Number(payroll.payroll_pf_employer_rate) * 100)} onChange={v => setPayroll(p => ({ ...p, payroll_pf_employer_rate: String(Number(v) / 100) }))} type="number" placeholder="12" />
                            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 text-sm">%</span>
                          </div>
                        </FieldRow>
                        <FieldRow label={`${getLabel('payroll_label_pf_cap')} (${currSym})`} hint={<InfoHint text="Maximum salary on which PF contributions are mandatory. Salary above this limit is not subject to PF." example="Cap ₹15,000 → employee with ₹30,000 basic still only contributes 12% of ₹15,000 = ₹1,800." />}>
                          <InputField value={payroll.payroll_pf_salary_cap} onChange={v => setPayroll(p => ({ ...p, payroll_pf_salary_cap: v }))} type="number" placeholder="15000" />
                        </FieldRow>
                        <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-slate-50 rounded-lg col-span-full md:col-span-1">
                          <div>
                            <p className="font-medium text-slate-700 text-sm flex items-center gap-1.5">Calculate PF on Full Basic Salary <InfoHint text="When enabled, PF is calculated on the actual basic salary even if it exceeds the statutory salary cap." example="Basic ₹30,000, cap ₹15,000, this ON → PF = 12% × ₹30,000 = ₹3,600 (voluntary higher contribution)." /></p>
                            <p className="text-xs text-slate-500">Ignores the salary cap (voluntary higher PF)</p>
                          </div>
                          <Toggle checked={payroll.payroll_pf_on_full_salary} onChange={v => setPayroll(p => ({ ...p, payroll_pf_on_full_salary: v }))} />
                        </div>
                      </div>
                    )}
                  </SectionCard>

                  {/* ─ Health Insurance / ESI ─ */}
                  <SectionCard title={getLabel('payroll_label_esi')} icon={Shield} badge="Health insurance / employee welfare contribution" collapsible>
                    <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-slate-50 rounded-lg">
                      <div>
                        <p className="text-sm font-medium text-slate-800 flex items-center gap-1.5">Enable {getLabel('payroll_label_esi')} <InfoHint text="Activates Employee State Insurance contributions for employees whose gross salary is at or below the salary cap." example="ESI on, cap ₹21,000 → employees earning ≤ ₹21,000 gross have ESI deducted. Those earning more are exempt." /></p>
                        <p className="text-xs text-slate-500">Applies to employees whose gross salary ≤ the salary cap</p>
                      </div>
                      <Toggle checked={payroll.payroll_esi_enabled} onChange={v => setPayroll(p => ({ ...p, payroll_esi_enabled: v }))} />
                    </div>
                    {payroll.payroll_esi_enabled && (
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 sm:gap-4">
                        <FieldRow label={getLabel('payroll_label_esi_employee_rate')} icon={Percent} hint={<InfoHint text="Percentage of gross salary deducted from the employee for Employee State Insurance." example="0.75% on ₹18,000 gross → ₹135 deducted from employee's salary each month." />}>
                          <div className="relative">
                            <InputField value={String(Number(payroll.payroll_esi_employee_rate) * 100)} onChange={v => setPayroll(p => ({ ...p, payroll_esi_employee_rate: String(Number(v) / 100) }))} type="number" placeholder="0.75" />
                            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 text-sm">%</span>
                          </div>
                        </FieldRow>
                        <FieldRow label={getLabel('payroll_label_esi_employer_rate')} icon={Percent} hint={<InfoHint text="Percentage of gross salary the company contributes to ESI on the employee's behalf." example="3.25% on ₹18,000 gross → company contributes ₹585 to ESI for that employee." />}>
                          <div className="relative">
                            <InputField value={String(Number(payroll.payroll_esi_employer_rate) * 100)} onChange={v => setPayroll(p => ({ ...p, payroll_esi_employer_rate: String(Number(v) / 100) }))} type="number" placeholder="3.25" />
                            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 text-sm">%</span>
                          </div>
                        </FieldRow>
                        <FieldRow label={`${getLabel('payroll_label_esi_cap')} (${currSym})`} hint={<InfoHint text="Gross salary threshold above which employees are not covered by ESI and no contributions are made." example="Cap ₹21,000 → an employee earning ₹22,000 gross is exempt from ESI; no deduction or contribution." />}>
                          <InputField value={payroll.payroll_esi_salary_cap} onChange={v => setPayroll(p => ({ ...p, payroll_esi_salary_cap: v }))} type="number" placeholder="21000" />
                        </FieldRow>
                      </div>
                    )}
                  </SectionCard>

                  {/* ─ Regional / Professional Tax ─ */}
                  <SectionCard title={getLabel('payroll_label_pt')} icon={BarChart2} badge="Regional monthly levy — configurable slabs" collapsible>
                    <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-slate-50 rounded-lg">
                      <div>
                        <p className="text-sm font-medium text-slate-800 flex items-center gap-1.5">Enable {getLabel('payroll_label_pt')} <InfoHint text="Activates state/regional Professional Tax deducted monthly based on gross salary slabs defined below." example="Gross ₹15,001–₹20,000 → PT slab ₹150/month. Gross > ₹20,000 → PT slab ₹200/month." /></p>
                        <p className="text-xs text-slate-500">State / regional tax deducted from monthly gross salary based on slab</p>
                      </div>
                      <Toggle checked={payroll.payroll_professional_tax_enabled} onChange={v => setPayroll(p => ({ ...p, payroll_professional_tax_enabled: v }))} />
                    </div>
                    {payroll.payroll_professional_tax_enabled && (
                      <div>
                        <div className="flex items-center justify-between mb-3">
                          <p className="text-xs font-medium text-slate-700">Monthly Tax Slabs</p>
                          <button onClick={addPtSlab} className="flex items-center gap-1 text-xs text-brand-primary hover:text-brand-primary/80 font-medium px-3 py-1.5 rounded-lg border border-brand-primary/30 hover:bg-brand-primary/5 transition-all">
                            <Plus size={14} /> Add slab
                          </button>
                        </div>
                        <div className="rounded-xl border border-slate-200 overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead className="bg-slate-50">
                              <tr>
                                <th className="px-3 py-2.5 text-left text-[11px] font-medium text-slate-500 uppercase tracking-wide">Gross Salary Up To ({currSym})</th>
                                <th className="px-3 py-2.5 text-left text-[11px] font-medium text-slate-500 uppercase tracking-wide">Tax Amount ({currSym})</th>
                                <th className="px-3 py-2.5" />
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                              {payroll.payroll_professional_tax_slabs.map((slab, i) => (
                                <tr key={i} className="hover:bg-slate-50">
                                  <td className="px-3 py-2">
                                    <input type="number" value={slab.upTo === 999999999 ? '' : slab.upTo}
                                      placeholder="No upper limit"
                                      onChange={e => updatePtSlab(i, 'upTo', e.target.value === '' ? '999999999' : e.target.value)}
                                      className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary" />
                                  </td>
                                  <td className="px-3 py-2">
                                    <input type="number" value={slab.tax}
                                      onChange={e => updatePtSlab(i, 'tax', e.target.value)}
                                      className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary" />
                                  </td>
                                  <td className="px-3 py-2 text-right">
                                    <button onClick={() => removePtSlab(i)} className="p-1.5 text-status-error/80 hover:text-status-error hover:bg-status-error-bg/30 rounded-lg transition-colors">
                                      <Trash2 size={14} />
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <p className="text-xs text-slate-400 mt-2">Leave "Up To" blank for the highest slab (becomes catch-all). Add slabs for each salary bracket in your region.</p>
                      </div>
                    )}
                  </SectionCard>

                  {/* ─ Income Tax / TDS ─ */}
                  <SectionCard title="Income Tax / TDS" icon={BarChart2} badge="Tax brackets · Deductions · Surcharge · Rebate" collapsible>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4">
                      <FieldRow label="Tax Regime" hint={<InfoHint text="Determines the income tax slab structure used for TDS deduction from salaries." example="New regime: flat rates, no deductions allowed. Old regime: higher rates but 80C/HRA/LTA exemptions apply." />}>
                        <select value={payroll.payroll_tax_regime} onChange={e => setPayroll(p => ({ ...p, payroll_tax_regime: e.target.value }))}
                          className="w-full h-10 px-3 border border-slate-200 rounded-lg focus:outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/30 transition-all text-sm bg-white">
                          <option value="new">New Regime (India FY 2025-26)</option>
                          <option value="old">Old Regime (India — with deductions)</option>
                          <option value="progressive">Progressive Brackets (Global / Custom)</option>
                        </select>
                      </FieldRow>
                      <FieldRow label="Tax Calculation Period" hint={<InfoHint text="How income tax is computed — either project annual income and divide by 12, or apply brackets directly to monthly income." example="Annual method: ₹3.6L/year income → annual tax calculated, then ₹X/12 deducted each month." />}>
                        <select value={payroll.payroll_tax_calculation_period} onChange={e => setPayroll(p => ({ ...p, payroll_tax_calculation_period: e.target.value }))}
                          className="w-full h-10 px-3 border border-slate-200 rounded-lg focus:outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/30 transition-all text-sm bg-white">
                          <option value="annual">Annual projection ÷ 12 months (India, UK, US, SG, DE)</option>
                          <option value="monthly">Apply brackets to monthly income directly</option>
                        </select>
                      </FieldRow>
                      {payroll.payroll_tax_calculation_period === 'annual' ? (
                        <FieldRow label={`Annual Standard Deduction (${currSym})`} hint={<InfoHint text="A flat deduction from gross annual income before calculating taxable income, applicable in most regimes." example="Standard deduction ₹50,000 → employee earning ₹6L/year pays tax on ₹5.5L instead." />}>
                          <InputField value={payroll.payroll_standard_deduction} onChange={v => setPayroll(p => ({ ...p, payroll_standard_deduction: v }))} type="number" placeholder="0" />
                        </FieldRow>
                      ) : (
                        <FieldRow label={`Monthly Personal Deduction (${currSym})`} hint={<InfoHint text="A fixed monthly deduction applied to gross income before tax brackets are calculated." example="Personal deduction ₹4,167/month → employee with ₹30,000 gross pays tax on ₹25,833." />}>
                          <InputField value={payroll.payroll_personal_deduction_monthly} onChange={v => setPayroll(p => ({ ...p, payroll_personal_deduction_monthly: v }))} type="number" placeholder="0" />
                        </FieldRow>
                      )}
                    </div>

                    {/* Tax Rebate */}
                    <div className="p-3 bg-status-success-bg/30 border border-status-success/20 rounded-lg">
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <p className="font-medium text-status-success text-sm flex items-center gap-1.5">{getLabel('payroll_label_rebate')} <InfoHint text="If an employee's total annual tax liability is below this threshold, the entire tax is waived (rebate u/s 87A in India)." example="Rebate limit ₹25,000 → employee with ₹24,000 annual tax liability pays ₹0 tax (fully waived)." /></p>
                          <p className="text-xs text-text-muted mt-0.5">Zero out income tax when annual taxable income ≤ the threshold</p>
                        </div>
                        <Toggle checked={payroll.payroll_tax_rebate_enabled} onChange={v => setPayroll(p => ({ ...p, payroll_tax_rebate_enabled: v }))} />
                      </div>
                      {payroll.payroll_tax_rebate_enabled && (
                        <FieldRow label={`Rebate Threshold — Annual Taxable Income Up To (${currSym})`}>
                          <InputField value={payroll.payroll_tax_rebate_limit} onChange={v => setPayroll(p => ({ ...p, payroll_tax_rebate_limit: v }))} type="number" placeholder="700000" />
                        </FieldRow>
                      )}
                    </div>

                    {/* Surcharge / Cess */}
                    <div className="p-3 bg-status-warning-bg/40 border border-status-warning/20 rounded-lg">
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <p className="font-medium text-status-warning text-sm flex items-center gap-1.5">{getLabel('payroll_label_cess')} <InfoHint text="An additional surcharge calculated as a percentage on top of the income tax liability." example="India 4% Health & Education Cess: income tax ₹10,000 → cess ₹400 → total tax ₹10,400." /></p>
                          <p className="text-xs text-text-muted mt-0.5">Applied on top of income tax (e.g. India: 4% Cess, Germany: 5.5% Soli)</p>
                        </div>
                        <Toggle checked={payroll.payroll_cess_enabled} onChange={v => setPayroll(p => ({ ...p, payroll_cess_enabled: v }))} />
                      </div>
                      {payroll.payroll_cess_enabled && (
                        <FieldRow label="Surcharge / Cess Rate" icon={Percent}>
                          <div className="relative">
                            <InputField value={String(Number(payroll.payroll_cess_rate) * 100)} onChange={v => setPayroll(p => ({ ...p, payroll_cess_rate: String(Number(v) / 100) }))} type="number" placeholder="4" />
                            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 text-sm">%</span>
                          </div>
                        </FieldRow>
                      )}
                    </div>

                    {/* Income Tax Brackets */}
                    <div>
                      <div className="flex items-center justify-between mb-3">
                        <p className="text-xs font-medium text-slate-700">Income Tax Brackets (Annual)</p>
                        <button onClick={addBracket} className="flex items-center gap-1 text-xs text-brand-primary hover:text-brand-primary/80 font-medium px-3 py-1.5 rounded-lg border border-brand-primary/30 hover:bg-brand-primary/5 transition-all">
                          <Plus size={14} /> Add bracket
                        </button>
                      </div>
                      <div className="rounded-xl border border-slate-200 overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead className="bg-slate-50">
                            <tr>
                              <th className="px-3 py-2.5 text-left text-[11px] font-medium text-slate-500 uppercase tracking-wide">Income Up To ({currSym})</th>
                              <th className="px-3 py-2.5 text-left text-[11px] font-medium text-slate-500 uppercase tracking-wide">Tax Rate (%)</th>
                              <th className="px-3 py-2.5" />
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {payroll.payroll_tax_brackets.map((bracket, i) => (
                              <tr key={i} className="hover:bg-slate-50">
                                <td className="px-3 py-2">
                                  <input type="number" value={bracket.limit === 999999999 ? '' : bracket.limit}
                                    placeholder="No upper limit"
                                    onChange={e => updateBracket(i, 'limit', e.target.value === '' ? '999999999' : e.target.value)}
                                    className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary" />
                                </td>
                                <td className="px-3 py-2">
                                  <div className="relative">
                                    <input type="number" value={bracket.rate * 100}
                                      onChange={e => updateBracket(i, 'rate', String(Number(e.target.value) / 100))}
                                      className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary pr-8" />
                                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs">%</span>
                                  </div>
                                </td>
                                <td className="px-3 py-2 text-right">
                                  <button onClick={() => removeBracket(i)} className="p-1.5 text-status-error/80 hover:text-status-error hover:bg-status-error-bg/30 rounded-lg transition-colors">
                                    <Trash2 size={14} />
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <p className="text-xs text-slate-400 mt-2">Leave "Income Up To" blank for the highest bracket (catch-all). Enter rates as percentages. Brackets apply progressively.</p>
                    </div>
                  </SectionCard>

                  {/* ─ Daily wage ─ */}
                  <SectionCard title="Daily Wage" icon={Percent} badge="Employees paid per day worked" collapsible>
                    <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-slate-50 rounded-lg">
                      <div>
                        <p className="text-sm font-medium text-slate-800 flex items-center gap-1.5">
                          Apply statutory deductions to daily-wage staff
                          <InfoHint
                            text="Whether employees whose Pay Basis is 'Daily wage' go through the same PF / ESI / professional tax / income tax pipeline as monthly staff. Turn it off to pay their earnings out gross."
                            example="Daily rate 30 x 22 days = 660 gross. ON: PF+ESI deducted. OFF: 660 paid as-is (discipline deductions and loan recovery still apply)."
                          />
                        </p>
                        <p className="text-xs text-slate-500">
                          Off = daily-wage earnings are paid gross; monthly employees are never affected either way.
                        </p>
                      </div>
                      <Toggle
                        checked={payroll.payroll_daily_wage_statutory_deductions}
                        onChange={v => setPayroll(p => ({ ...p, payroll_daily_wage_statutory_deductions: v }))}
                      />
                    </div>

                    <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-slate-50 rounded-lg mt-2">
                      <div>
                        <p className="text-sm font-medium text-slate-800 flex items-center gap-1.5">
                          Pay for approved paid leave
                          <InfoHint
                            text="By default a daily-wage employee earns only on days actually worked, so approved paid leave pays nothing. Turn this on to pay their day rate for approved paid-leave days too. Unpaid leave types never pay."
                            example="Rate 500/day, 22 days worked + 2 approved paid leave days. ON: 12,000. OFF: 11,000."
                          />
                        </p>
                        <p className="text-xs text-slate-500">
                          Off = only days actually worked are paid. Monthly employees already include paid leave in their salary.
                        </p>
                      </div>
                      <Toggle
                        checked={payroll.payroll_daily_wage_pay_leave}
                        onChange={v => setPayroll(p => ({ ...p, payroll_daily_wage_pay_leave: v }))}
                      />
                    </div>

                    <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-slate-50 rounded-lg mt-2">
                      <div>
                        <p className="text-sm font-medium text-slate-800 flex items-center gap-1.5">
                          Pay for public holidays
                          <InfoHint
                            text="Pay daily-wage staff their day rate for public holidays in the period. Holidays that fall on a weekly-off day are excluded, and so are holidays the employee actually worked (already paid as a present day)."
                            example="Rate 500/day, 20 days worked + 2 public holidays not worked. ON: 11,000. OFF: 10,000."
                          />
                        </p>
                        <p className="text-xs text-slate-500">
                          Off = public holidays are unpaid. Weekly-off days are never paid either way.
                        </p>
                      </div>
                      <Toggle
                        checked={payroll.payroll_daily_wage_pay_holidays}
                        onChange={v => setPayroll(p => ({ ...p, payroll_daily_wage_pay_holidays: v }))}
                      />
                    </div>
                  </SectionCard>
                </div>
              )}

              {/* ── Libraries Settings ── */}
              {activeTab === 'libraries' && user?.role === 'ADMIN' && (
                <LibrariesManagement />
              )}

              {/* ── Overtime Settings ── */}
              {activeTab === 'overtime' && user?.role === 'ADMIN' && (
                <div className="space-y-4 sm:space-y-5">
                  {/* Header card */}
                  <div className="surface-panel p-4 sm:p-5">
                    <h2 className="text-sm sm:text-base font-semibold text-text-heading mb-0.5">Overtime Settings</h2>
                    <p className="text-xs text-slate-500">Configure global overtime behavior, limits, food allowance, and pay rates</p>
                  </div>

                  {/* ─ Global Toggle ─ */}
                  <SectionCard title="Overtime Feature Toggle" icon={Clock} badge="Enable or disable the overtime requests system">
                    <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-slate-50 rounded-lg">
                      <div>
                        <p className="text-sm font-medium text-slate-800 flex items-center gap-1.5">Enable Overtime requests <InfoHint text="Master switch for the entire overtime system. When off, no OT requests can be submitted or approved." example="Disable before a company holiday freeze to prevent employees from logging OT during shutdown." /></p>
                        <p className="text-xs text-slate-500 mt-0.5 max-w-lg">
                          Turn on/off the overtime request option. When disabled, employees and managers cannot view or submit overtime requests. Existing requests are preserved in history.
                        </p>
                      </div>
                      <Toggle checked={overtimeSettings.overtime_enabled} onChange={v => setOvertimeSettings(o => ({ ...o, overtime_enabled: v }))} />
                    </div>
                  </SectionCard>

                  {overtimeSettings.overtime_enabled && (
                    <>
                      {/* ─ Submission Rules ─ */}
                      <SectionCard title="Submission & Approval Rules" icon={Sliders} collapsible>
                        <div className="flex flex-col gap-3">
                          <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-slate-50 rounded-lg">
                            <div>
                              <p className="text-sm font-medium text-slate-800 flex items-center gap-1.5">Allow Employee Submission <InfoHint text="Lets employees initiate their own OT requests. When off, only managers or HR can record overtime on behalf of an employee." example="Employee works late, opens the OT portal, submits a 2-hour request → goes to manager for approval." /></p>
                              <p className="text-xs text-slate-500 mt-0.5 max-w-lg">
                                When enabled, standard employees can submit their own overtime requests. When disabled, only admins or HR managers can log overtime hours for them.
                              </p>
                            </div>
                            <Toggle checked={overtimeSettings.overtime_allow_employee_submit} onChange={v => setOvertimeSettings(o => ({ ...o, overtime_allow_employee_submit: v }))} />
                          </div>

                          <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-slate-50 rounded-lg">
                            <div>
                              <p className="text-sm font-medium text-slate-800 flex items-center gap-1.5">Require Manager Approval <InfoHint text="OT hours are not payable until explicitly approved by a manager. Without this, submitted OT is auto-approved." example="Employee submits OT → status is 'Pending' → manager approves → hours added to next payroll run." /></p>
                              <p className="text-xs text-slate-500 mt-0.5 max-w-lg">
                                When enabled, overtime requests must be approved by a manager or HR before the hours are counted towards payroll.
                              </p>
                            </div>
                            <Toggle checked={overtimeSettings.overtime_require_manager_approval} onChange={v => setOvertimeSettings(o => ({ ...o, overtime_require_manager_approval: v }))} />
                          </div>
                        </div>
                      </SectionCard>

                      {/* ─ Shift & OT Boundaries ─ */}
                      <SectionCard title="Shift & Overtime Boundaries" icon={Clock} collapsible>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4">
                          <FieldRow label="Weekday OT Permitted From (Shift End)" icon={Clock} hint={<InfoHint text="The earliest time after which overtime can be claimed on regular weekdays. Work before this time is not counted as OT." example="Shift ends 5:30 PM, OT permitted from 6:00 PM → work between 5:30–6:00 PM is not billable OT." />}>
                            <InputField
                              type="text"
                              value={overtimeSettings.overtime_shift_end_time}
                              onChange={v => setOvertimeSettings(o => ({ ...o, overtime_shift_end_time: v }))}
                              placeholder="17:00"
                            />
                          </FieldRow>
                          <FieldRow label="Late OT Threshold Time (HH:MM)" icon={Clock} hint={<InfoHint text="After this time, overtime shifts into the 'Late OT' tier and earns the higher late OT rate multiplier." example="Threshold 9 PM → regular OT from 6–9 PM at ×1.5, late OT after 9 PM at ×2.0." />}>
                            <InputField
                              type="text"
                              value={overtimeSettings.overtime_late_threshold}
                              onChange={v => setOvertimeSettings(o => ({ ...o, overtime_late_threshold: v }))}
                              placeholder="22:00"
                            />
                          </FieldRow>
                        </div>
                      </SectionCard>

                      {/* ─ Limits Config ─ */}
                      <SectionCard title="Overtime Threshold Limits" icon={Calendar} collapsible>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 sm:gap-4">
                          <FieldRow label="Max Overtime Hours per Day" icon={Clock} hint={<InfoHint text="Hard cap on overtime per day. Requests that would exceed this limit are automatically rejected." example="Cap 3 hrs/day → employee already with 3 OT hours cannot submit another request for that day." />}>
                            <InputField
                              type="number"
                              value={overtimeSettings.overtime_max_hours_per_day}
                              onChange={v => setOvertimeSettings(o => ({ ...o, overtime_max_hours_per_day: v }))}
                              placeholder="4"
                              min="0"
                            />
                          </FieldRow>
                          <FieldRow label="Max Overtime Hours per Month" icon={Calendar} hint={<InfoHint text="Hard cap on total overtime hours per employee per calendar month." example="Cap 20 hrs/month → on the 21st submitted OT hour, the system blocks the request." />}>
                            <InputField
                              type="number"
                              value={overtimeSettings.overtime_max_hours_per_month}
                              onChange={v => setOvertimeSettings(o => ({ ...o, overtime_max_hours_per_month: v }))}
                              placeholder="30"
                              min="0"
                            />
                          </FieldRow>
                          <FieldRow label="Max Overtime Hours per Year" icon={Sliders} hint={<InfoHint text="Hard cap on total overtime hours per employee per calendar year, tracked cumulatively." example="Cap 200 hrs/year → once reached, no further OT requests can be submitted that year." />}>
                            <InputField
                              type="number"
                              value={overtimeSettings.overtime_max_hours_per_year}
                              onChange={v => setOvertimeSettings(o => ({ ...o, overtime_max_hours_per_year: v }))}
                              placeholder="200"
                              min="0"
                            />
                          </FieldRow>
                        </div>
                      </SectionCard>

                      {/* ─ Pay Rates ─ */}
                      <SectionCard title="Overtime Pay Rate Multipliers" icon={CurrencyIcon} collapsible>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4">
                          <FieldRow label="Regular Overtime Rate Multiplier" icon={Percent} hint={<InfoHint text="Multiplier applied to the employee's hourly rate for overtime worked before the late OT threshold." example="Hourly rate ₹500 × regular rate 1.5 = ₹750/hr paid for evening OT hours (before the late threshold)." />}>
                            <InputField
                              type="number"
                              step="0.1"
                              value={overtimeSettings.overtime_regular_rate}
                              onChange={v => setOvertimeSettings(o => ({ ...o, overtime_regular_rate: v }))}
                              placeholder="1.5"
                              min="0"
                            />
                          </FieldRow>
                          <FieldRow label="Late Overtime Rate Multiplier" icon={Percent} hint={<InfoHint text="Multiplier applied to the hourly rate for overtime worked after the late OT threshold time." example="Hourly rate ₹500 × late rate 2.0 = ₹1,000/hr paid for work after 9 PM (past the late threshold)." />}>
                            <InputField
                              type="number"
                              step="0.1"
                              value={overtimeSettings.overtime_late_rate}
                              onChange={v => setOvertimeSettings(o => ({ ...o, overtime_late_rate: v }))}
                              placeholder="1.5"
                              min="0"
                            />
                          </FieldRow>
                        </div>
                      </SectionCard>

                      {/* ─ Double OT (Sunday / Holiday) ─ */}
                      <SectionCard title="Double OT (Sunday / Holiday)" icon={Sliders} collapsible>
                        <div className="flex flex-col gap-3">
                          <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-slate-50 rounded-lg">
                            <div>
                              <p className="text-sm font-medium text-slate-800 flex items-center gap-1.5">Enable Sunday & Holiday Double OT <InfoHint text="When enabled, overtime on Sundays or public holidays uses the double OT rate multiplier instead of the regular OT rate." example="Employee works 4 hrs on a public holiday → each hour at ×2.5 = ₹1,250 instead of regular ₹750/hr." /></p>
                              <p className="text-xs text-slate-500 mt-0.5 max-w-lg">
                                Enable a custom pay multiplier and special rules for overtime worked on Sundays and Public Holidays.
                              </p>
                            </div>
                            <Toggle checked={overtimeSettings.overtime_double_ot_enabled} onChange={v => setOvertimeSettings(o => ({ ...o, overtime_double_ot_enabled: v }))} />
                          </div>

                          {overtimeSettings.overtime_double_ot_enabled && (
                            <div className="flex flex-col gap-3 pt-2">
                              {/* Sunday OT tiers */}
                              <div className="rounded-lg border border-slate-200 p-3">
                                <p className="text-sm font-semibold text-slate-800 mb-2.5">Sunday Overtime</p>
                                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 sm:gap-4">
                                  <FieldRow label="Regular Rate Multiplier" icon={Percent} hint={<InfoHint text="Multiplier for Sunday overtime worked BEFORE the Sunday late threshold." example="Sunday regular rate 2.0 × ₹500/hr = ₹1,000/hr for daytime Sunday OT." />}>
                                    <InputField
                                      type="number"
                                      step="0.1"
                                      value={overtimeSettings.overtime_sunday_regular_rate}
                                      onChange={v => setOvertimeSettings(o => ({ ...o, overtime_sunday_regular_rate: v }))}
                                      placeholder="2.0"
                                      min="0"
                                    />
                                  </FieldRow>
                                  <FieldRow label="Late Rate Multiplier" icon={Percent} hint={<InfoHint text="Multiplier for Sunday overtime worked AFTER the Sunday late threshold." example="Sunday late rate 2.5 × ₹500/hr = ₹1,250/hr for late-night Sunday OT." />}>
                                    <InputField
                                      type="number"
                                      step="0.1"
                                      value={overtimeSettings.overtime_sunday_late_rate}
                                      onChange={v => setOvertimeSettings(o => ({ ...o, overtime_sunday_late_rate: v }))}
                                      placeholder="2.0"
                                      min="0"
                                    />
                                  </FieldRow>
                                  <FieldRow label="Late Threshold (HH:MM)" icon={Clock} hint={<InfoHint text="Time after which Sunday overtime is paid at the Sunday late rate instead of the Sunday regular rate." example="Set 22:00 → Sunday hours worked past 10 PM are paid at the Sunday late rate." />}>
                                    <InputField
                                      type="time"
                                      value={overtimeSettings.overtime_sunday_late_threshold}
                                      onChange={v => setOvertimeSettings(o => ({ ...o, overtime_sunday_late_threshold: v }))}
                                      placeholder="22:00"
                                    />
                                  </FieldRow>
                                </div>
                              </div>

                              {/* Holiday OT tiers */}
                              <div className="rounded-lg border border-slate-200 p-3">
                                <p className="text-sm font-semibold text-slate-800 mb-2.5">Public Holiday Overtime</p>
                                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 sm:gap-4">
                                  <FieldRow label="Regular Rate Multiplier" icon={Percent} hint={<InfoHint text="Multiplier for public holiday overtime worked BEFORE the holiday late threshold." example="Holiday regular rate 2.5 × ₹500/hr = ₹1,250/hr for daytime holiday OT." />}>
                                    <InputField
                                      type="number"
                                      step="0.1"
                                      value={overtimeSettings.overtime_holiday_regular_rate}
                                      onChange={v => setOvertimeSettings(o => ({ ...o, overtime_holiday_regular_rate: v }))}
                                      placeholder="2.0"
                                      min="0"
                                    />
                                  </FieldRow>
                                  <FieldRow label="Late Rate Multiplier" icon={Percent} hint={<InfoHint text="Multiplier for public holiday overtime worked AFTER the holiday late threshold." example="Holiday late rate 3.0 × ₹500/hr = ₹1,500/hr for late-night holiday OT." />}>
                                    <InputField
                                      type="number"
                                      step="0.1"
                                      value={overtimeSettings.overtime_holiday_late_rate}
                                      onChange={v => setOvertimeSettings(o => ({ ...o, overtime_holiday_late_rate: v }))}
                                      placeholder="2.0"
                                      min="0"
                                    />
                                  </FieldRow>
                                  <FieldRow label="Late Threshold (HH:MM)" icon={Clock} hint={<InfoHint text="Time after which public holiday overtime is paid at the holiday late rate instead of the holiday regular rate." example="Set 20:00 → holiday hours worked past 8 PM are paid at the holiday late rate." />}>
                                    <InputField
                                      type="time"
                                      value={overtimeSettings.overtime_holiday_late_threshold}
                                      onChange={v => setOvertimeSettings(o => ({ ...o, overtime_holiday_late_threshold: v }))}
                                      placeholder="22:00"
                                    />
                                  </FieldRow>
                                </div>
                                <p className="text-xs text-slate-500 mt-2">A Sunday that is also a public holiday uses these holiday rates.</p>
                              </div>

                              <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-slate-50 rounded-lg">
                                <div>
                                  <p className="text-sm font-medium text-slate-800 flex items-center gap-1.5">Allow Request Any Time of Day <InfoHint text="When double OT is enabled, this lets employees submit holiday OT requests at any time, not just after the weekday OT threshold." example="Sunday OT request at 10 AM is accepted even though it's before the 6 PM weekday OT permitted-from time." /></p>
                                  <p className="text-xs text-slate-500 mt-0.5 max-w-lg">
                                    When enabled, Sunday/Holiday overtime can be requested during regular shift hours (e.g., all-day work). When disabled, it is subject to shift boundaries.
                                  </p>
                                </div>
                                <Toggle checked={overtimeSettings.overtime_double_ot_allow_anytime} onChange={v => setOvertimeSettings(o => ({ ...o, overtime_double_ot_allow_anytime: v }))} />
                              </div>

                              <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-slate-50 rounded-lg">
                                <div>
                                  <p className="text-sm font-medium text-slate-800 flex items-center gap-1.5">Always Apply Food Allowance <InfoHint text="When enabled, the food allowance is added to any double OT session regardless of the time it ends." example="Employee works 10 AM–2 PM on a Sunday holiday → food allowance ₹150 added even though they didn't work past the late-night threshold." /></p>
                                  <p className="text-xs text-slate-500 mt-0.5 max-w-lg">
                                    When enabled, food allowance is automatically paid for Sunday/Holiday overtime requests regardless of whether they exceed the late-night threshold.
                                  </p>
                                </div>
                                <Toggle checked={overtimeSettings.overtime_double_food_allowance_any_time} onChange={v => setOvertimeSettings(o => ({ ...o, overtime_double_food_allowance_any_time: v }))} />
                              </div>
                            </div>
                          )}
                        </div>
                      </SectionCard>

                      {/* ─ Food Allowance ─ */}
                      <SectionCard title="Overtime Food Allowance" icon={Mail} collapsible>
                        <div className="flex flex-col gap-3">
                          <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-slate-50 rounded-lg">
                            <div>
                              <p className="text-sm font-medium text-slate-800 flex items-center gap-1.5">Enable Late-Night Food Allowance <InfoHint text="Pays a fixed food stipend to employees who work overtime past the late OT threshold time." example="Late OT threshold 9 PM, food allowance ₹150 → any employee working past 9 PM gets ₹150 added to their payslip." /></p>
                              <p className="text-xs text-slate-500 mt-0.5 max-w-lg">
                                Enable a flat-rate food allowance payout for overtime shifts ending after a late-night threshold time.
                              </p>
                            </div>
                            <Toggle checked={overtimeSettings.overtime_food_allowance_enabled} onChange={v => setOvertimeSettings(o => ({ ...o, overtime_food_allowance_enabled: v }))} />
                          </div>

                          {overtimeSettings.overtime_food_allowance_enabled && (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4 pt-2">
                              <FieldRow label="Food Allowance Threshold Time (HH:MM)" icon={Clock} hint={<InfoHint text="Overtime requests ending after this time qualify for the food allowance. Independent of the late OT pay-rate threshold." example="Set 22:00 → an employee whose OT ends at 22:30 gets the food allowance; one ending at 21:00 does not." />}>
                                <InputField
                                  type="time"
                                  value={overtimeSettings.overtime_food_allowance_threshold}
                                  onChange={v => setOvertimeSettings(o => ({ ...o, overtime_food_allowance_threshold: v }))}
                                  placeholder="22:00"
                                />
                              </FieldRow>
                              <FieldRow label={`Food Allowance Amount (${currSym})`} icon={CurrencyIcon} hint={<InfoHint text="The fixed amount paid per late-OT session when the food allowance is triggered." example="Amount ₹200 → each shift that crosses the food allowance threshold adds exactly ₹200 to the employee's monthly payslip." />}>
                                <InputField
                                  type="number"
                                  value={overtimeSettings.overtime_food_allowance_amount}
                                  onChange={v => setOvertimeSettings(o => ({ ...o, overtime_food_allowance_amount: v }))}
                                  placeholder="150"
                                  min="0"
                                />
                              </FieldRow>
                            </div>
                          )}
                        </div>
                      </SectionCard>
                    </>
                  )}
                </div>
              )}

              {/*
                ── Save Button ──

                Offered ONLY on the tabs `handleSave` can actually save.

                It used to render nearly everywhere, and `handleSave` fell
                through to a bare `toast.success('Settings saved
                successfully!')` for every tab it did not recognise — so on
                Holidays, Approval Hierarchy, Overtime Policies, Salary Payment
                Files and Security an administrator typed a change, pressed
                Save, was told it had worked, and nothing was written. A save
                control must either save or not be offered.

                Those all carry their own controls: `HolidaysManager`, the
                approval-hierarchy panel, the overtime-policies panel, and
                Security's own `Update password` submit. They join the list
                already excluded for exactly that reason.
              */}
              {!SELF_SAVING_TABS.has(activeTab) && (
                <div className={`surface-panel p-3 sm:p-4 ${(activeTab !== 'system' && activeTab !== 'branding' && activeTab !== 'payroll' && activeTab !== 'overtime') || user?.role !== 'ADMIN' ? 'mt-0' : ''}`}>
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs text-slate-500">
                      {activeTab === 'payroll'
                        ? 'Save all payroll configuration changes'
                        : activeTab === 'overtime'
                          ? 'Save all overtime configuration changes'
                          : activeTab === 'system'
                            ? 'Save all system configuration changes'
                            : activeTab === 'branding'
                              ? 'Save branding & theme changes'
                              : 'Save your personal preferences'}
                    </p>
                    <button
                      id="save-settings-btn"
                      data-testid="settings-save"
                      onClick={handleSave}
                      disabled={saving}
                      className="inline-flex items-center justify-center gap-2 h-10 px-4 shrink-0 bg-brand-primary hover:bg-brand-primary-dark text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
                    >
                      <Save size={16} />
                      {saving ? 'Saving...' : 'Save changes'}
                    </button>
                  </div>
                </div>
              )}
            </motion.div>
          </div>
        </div>
      </div>
    </>
  );
}

function LibrariesManagement() {
  const [libraryType, setLibraryType] = useState<LibraryTypeValue>('POSITION');
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [newItemLabel, setNewItemLabel] = useState('');

  // LEAVE_TYPE metadata states
  const [defaultDays, setDefaultDays] = useState<number>(0);
  const [isPaid, setIsPaid] = useState<boolean>(true);
  const [requiresNoticeDays, setRequiresNoticeDays] = useState<number>(0);
  const [affectsBalance, setAffectsBalance] = useState<boolean>(true);
  const [genderRestriction, setGenderRestriction] = useState<string>('');

  // EMPLOYMENT_TYPE metadata. '' = not set, so the employee keeps their own
  // Pay Basis; MONTHLY/DAILY force it and lock the field on the employee form.
  const [payBasis, setPayBasis] = useState<'' | 'MONTHLY' | 'DAILY'>('');
  const [perDiemRate, setPerDiemRate] = useState<string>('');
  const [editingPayBasis, setEditingPayBasis] = useState<'' | 'MONTHLY' | 'DAILY'>('');
  const [editingPerDiemRate, setEditingPerDiemRate] = useState<string>('');

  // Editing states
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState('');
  const [editingDefaultDays, setEditingDefaultDays] = useState<number>(0);
  const [editingIsPaid, setEditingIsPaid] = useState<boolean>(true);
  const [editingRequiresNoticeDays, setEditingRequiresNoticeDays] = useState<number>(0);
  const [editingAffectsBalance, setEditingAffectsBalance] = useState<boolean>(true);
  const [editingGenderRestriction, setEditingGenderRestriction] = useState<string>('');

  const [addingItem, setAddingItem] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ top: number; right: number } | null>(null);

  const fetchItems = useCallback(async () => {
    try {
      setLoading(true);
      const res = await libraryService.getAll(libraryType);
      if (res.success) {
        setItems(res.data);
      }
    } catch (err: any) {
      toast.error('Failed to load library items');
    } finally {
      setLoading(false);
    }
  }, [libraryType]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  useEffect(() => {
    if (!openMenuId) return;
    const close = () => { setOpenMenuId(null); setMenuPosition(null); };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [openMenuId]);

  const handleAddItem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newItemLabel.trim()) return;
    try {
      setAddingItem(true);
      const payload: any = {
        libraryType,
        label: newItemLabel.trim(),
        isActive: true,
        sortOrder: 0,
      };
      if (libraryType === 'LEAVE_TYPE') {
        payload.defaultDays = Number(defaultDays);
        payload.isPaid = isPaid;
        payload.requiresNoticeDays = Number(requiresNoticeDays);
        payload.affectsBalance = affectsBalance;
        payload.genderRestriction = genderRestriction || null;
      }
      if (libraryType === 'EMPLOYMENT_TYPE') {
        payload.payBasis = payBasis || null;
      }
      if (libraryType === 'PER_DIEM_DESTINATION') {
        // Blank stays null — a destination with no rate simply produces no
        // per-diem claim, which is different from a rate of zero.
        payload.perDiemRate = perDiemRate === '' ? null : Number(perDiemRate);
      }
      const res = await libraryService.create(payload);
      if (res.success) {
        toast.success('Library item added successfully');
        setNewItemLabel('');
        setDefaultDays(0);
        setIsPaid(true);
        setRequiresNoticeDays(0);
        setAffectsBalance(true);
        setGenderRestriction('');
        setPayBasis('');
        setPerDiemRate('');
        fetchItems();
      }
    } catch (err: any) {
      toast.error(err.message || 'Failed to add item');
    } finally {
      setAddingItem(false);
    }
  };

  const handleToggleActive = async (id: string, currentStatus: boolean) => {
    try {
      const res = await libraryService.update(id, { isActive: !currentStatus });
      if (res.success) {
        toast.success(`Item status updated`);
        fetchItems();
      }
    } catch (err: any) {
      toast.error('Failed to update status');
    }
  };

  const handleStartEdit = (item: any) => {
    setEditingItemId(item.id);
    setEditingLabel(item.label);
    setEditingDefaultDays(item.defaultDays || 0);
    setEditingIsPaid(item.isPaid !== false);
    setEditingRequiresNoticeDays(item.requiresNoticeDays || 0);
    setEditingAffectsBalance(item.affectsBalance !== false);
    setEditingGenderRestriction(item.genderRestriction || '');
    setEditingPayBasis(item.payBasis || '');
    setEditingPerDiemRate(item.perDiemRate != null ? String(item.perDiemRate) : '');
  };

  const handleSaveEdit = async (id: string) => {
    if (!editingLabel.trim()) return;
    try {
      const payload: any = {
        label: editingLabel.trim(),
      };
      if (libraryType === 'LEAVE_TYPE') {
        payload.defaultDays = Number(editingDefaultDays);
        payload.isPaid = editingIsPaid;
        payload.requiresNoticeDays = Number(editingRequiresNoticeDays);
        payload.affectsBalance = editingAffectsBalance;
        payload.genderRestriction = editingGenderRestriction || null;
      }
      if (libraryType === 'EMPLOYMENT_TYPE') {
        payload.payBasis = editingPayBasis || null;
      }
      if (libraryType === 'PER_DIEM_DESTINATION') {
        payload.perDiemRate =
          editingPerDiemRate === '' ? null : Number(editingPerDiemRate);
      }
      const res = await libraryService.update(id, payload);
      if (res.success) {
        toast.success('Item updated successfully');
        setEditingItemId(null);
        fetchItems();
      }
    } catch (err: any) {
      toast.error(err.message || 'Failed to update item');
    }
  };

  const handleDeleteItem = async (id: string) => {
    if (!confirm('Are you sure you want to delete this item?')) return;
    try {
      const res = await libraryService.delete(id);
      if (res.success) {
        toast.success('Item deleted successfully');
        fetchItems();
      }
    } catch (err: any) {
      toast.error('Failed to delete item');
    }
  };

  const handleSeed = async () => {
    try {
      setSeeding(true);
      const res = await libraryService.seed();
      if (res.success) {
        toast.success('Default values seeded successfully');
        fetchItems();
      }
    } catch (err) {
      toast.error('Failed to seed defaults');
    } finally {
      setSeeding(false);
    }
  };

  const libraryTypes = [
    { value: 'POSITION' as const, label: 'Positions', description: 'Employee job titles / designations' },
    { value: 'SALARY_COMPONENT_TYPE' as const, label: 'Salary Components', description: 'Components used in payroll (e.g. Basic, Allowance)' },
    { value: 'CONTRACT_TYPE' as const, label: 'Contract Types', description: 'Types of employment contracts' },
    { value: 'EMPLOYMENT_TYPE' as const, label: 'Employment Types', description: 'Employment classifications that drive overtime policy (e.g. Monthly, Daily Wage)' },
    { value: 'WORK_MODE' as const, label: 'Work Modes', description: 'Employment engagement mode (e.g. Full-time)' },
    { value: 'LEAVE_TYPE' as const, label: 'Leave Types', description: 'Types of leave employees can apply for' },
    { value: 'DOCUMENT_TYPE' as const, label: 'Document Types', description: 'Types of documents employees can upload' },
    { value: 'VISA_TYPE' as const, label: 'Visa Types', description: 'Visa categories used in the employee visa section (e.g. Employment Visa)' },
    { value: 'ASSET_CATEGORY' as const, label: 'Asset Categories', description: 'Categories in the asset register (e.g. Laptop, Vehicle, SIM Card)' },
    { value: 'PER_DIEM_DESTINATION' as const, label: 'Travel Destinations', description: 'Destinations selectable on a travel request, each with its daily per-diem rate' },
    { value: 'COURSE_CATEGORY' as const, label: 'Course Categories', description: 'Categories for the training course catalogue' },
    { value: 'BUDGET_CATEGORY' as const, label: 'Budget Categories', description: 'Headings a budget line is planned against (Payroll, Travel, Training…)' },
    { value: 'GRIEVANCE_CATEGORY' as const, label: 'Grievance Categories', description: 'Categories an employee picks when raising a grievance' },
  ];

  return (
    <div className="space-y-4 sm:space-y-5">
      <div className="surface-panel p-4 sm:p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h2 className="text-sm sm:text-base font-semibold text-text-heading mb-0.5">Libraries</h2>
          <p className="text-xs text-slate-500 font-medium">Configure global drop-down options for the application dynamically</p>
        </div>
        <button
          onClick={handleSeed}
          disabled={seeding}
          className="flex items-center justify-center gap-1.5 h-9 px-3 border border-slate-200 hover:border-brand-primary hover:text-brand-primary rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
        >
          <RotateCcw size={16} />
          {seeding ? 'Seeding...' : 'Seed Defaults'}
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 md:gap-6">
        <div className="md:col-span-1 space-y-3">
          <div className="surface-panel p-3">
            <h3 className="font-semibold text-slate-700 text-sm mb-3 px-2">Library Categories</h3>
            <div className="space-y-1">
              {libraryTypes.map(t => (
                <button
                  key={t.value}
                  onClick={() => setLibraryType(t.value)}
                  className={`w-full text-left px-3 py-2.5 rounded-lg transition-all ${libraryType === t.value
                      ? 'bg-brand-primary/10 text-brand-primary font-semibold shadow-xs'
                      : 'text-slate-600 hover:bg-slate-50'
                    }`}
                >
                  <p className="text-sm">{t.label}</p>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="md:col-span-3 space-y-4">
          <div className="surface-panel p-4 sm:p-5">
            <div className="flex items-center justify-between border-b border-slate-100 pb-4 mb-4">
              <h3 className="text-sm sm:text-base font-semibold text-slate-800">
                {libraryTypes.find(t => t.value === libraryType)?.label} Items
              </h3>
              <span className="text-xs px-2.5 py-1 bg-slate-100 text-slate-650 rounded-full font-medium">
                {items.length} options
              </span>
            </div>

            <form onSubmit={handleAddItem} className="space-y-4 mb-6">
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder={`Add new item...`}
                  value={newItemLabel}
                  onChange={e => setNewItemLabel(e.target.value)}
                  disabled={addingItem}
                  className="flex-1 h-10 px-3 border border-slate-200 rounded-lg focus:outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/30 transition-all text-sm"
                />
                <button
                  type="submit"
                  disabled={addingItem || !newItemLabel.trim()}
                  className="h-10 px-4 bg-brand-primary text-white rounded-lg hover:bg-brand-primary-dark font-medium text-sm transition-colors flex items-center gap-1.5 disabled:opacity-50"
                >
                  <Plus size={16} />
                  Add
                </button>
              </div>

              {libraryType === 'EMPLOYMENT_TYPE' && (
                <div className="p-3 bg-slate-50 rounded-lg border border-slate-200 text-xs">
                  <span className="text-slate-500 font-semibold block mb-1.5">Pay Basis</span>
                  <div className="flex gap-1">
                    {[
                      { value: '' as const, label: 'Not set', active: 'bg-slate-200 text-slate-700', inactive: 'bg-white text-slate-400 border border-slate-200' },
                      { value: 'MONTHLY' as const, label: 'Monthly salary', active: 'bg-blue-100 text-blue-600 border border-blue-300', inactive: 'bg-white text-slate-400 border border-slate-200' },
                      { value: 'DAILY' as const, label: 'Daily wage', active: 'bg-amber-100 text-amber-700 border border-amber-300', inactive: 'bg-white text-slate-400 border border-slate-200' },
                    ].map(opt => (
                      <button
                        key={opt.value || 'none'}
                        type="button"
                        onClick={() => setPayBasis(opt.value)}
                        className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all ${payBasis === opt.value ? opt.active : opt.inactive}`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <p className="text-slate-500 mt-1.5">
                    Locks the Pay Basis field on the employee form for anyone with this
                    employment type. &quot;Daily wage&quot; makes their base salary a
                    <strong> per-day rate</strong>. Leave it &quot;Not set&quot; to let HR choose per employee.
                  </p>
                </div>
              )}

              {libraryType === 'PER_DIEM_DESTINATION' && (
                <div className="p-3 bg-slate-50 rounded-lg border border-slate-200 text-xs">
                  <label className="flex flex-col">
                    <span className="text-slate-500 font-semibold mb-1">Per-diem rate (per day)</span>
                    <input
                      type="number"
                      min={0}
                      step="0.001"
                      value={perDiemRate}
                      onChange={e => setPerDiemRate(e.target.value)}
                      placeholder="Leave blank for no per-diem"
                      className="px-3 py-1.5 border border-slate-200 rounded-lg focus:outline-none focus:border-brand-primary text-sm bg-white"
                    />
                  </label>
                  <p className="text-slate-500 mt-1.5">
                    Snapshotted onto a travel request when it is submitted, so editing
                    this rate later never changes an already-approved trip.
                  </p>
                </div>
              )}

              {libraryType === 'LEAVE_TYPE' && (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 p-3 bg-slate-50 rounded-lg border border-slate-200 text-xs">
                  <label className="flex flex-col">
                    <span className="text-slate-500 font-semibold mb-1">Default Days</span>
                    <input
                      type="number"
                      value={defaultDays}
                      onChange={e => setDefaultDays(Number(e.target.value))}
                      className="px-3 py-1.5 border border-slate-200 rounded-lg focus:outline-none focus:border-brand-primary text-sm bg-white"
                    />
                  </label>
                  <label className="flex flex-col">
                    <span className="text-slate-500 font-semibold mb-1">Notice Days</span>
                    <input
                      type="number"
                      value={requiresNoticeDays}
                      onChange={e => setRequiresNoticeDays(Number(e.target.value))}
                      className="px-3 py-1.5 border border-slate-200 rounded-lg focus:outline-none focus:border-brand-primary text-sm bg-white"
                    />
                  </label>
                  <div className="flex flex-col">
                    <span className="text-slate-500 font-semibold mb-1">Gender</span>
                    <div className="flex gap-1">
                      {[
                        { value: '', label: 'All', active: 'bg-slate-200 text-slate-700', inactive: 'bg-white text-slate-400 border border-slate-200' },
                        { value: 'MALE', label: 'Male', active: 'bg-blue-100 text-blue-600 border border-blue-300', inactive: 'bg-white text-slate-400 border border-slate-200' },
                        { value: 'FEMALE', label: 'Female', active: 'bg-pink-100 text-pink-600 border border-pink-300', inactive: 'bg-white text-slate-400 border border-slate-200' },
                      ].map(opt => (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => setGenderRestriction(opt.value)}
                          className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all ${genderRestriction === opt.value ? opt.active : opt.inactive}`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <label className="flex flex-col cursor-pointer select-none">
                    <span className="text-slate-500 font-semibold mb-1">Is Paid</span>
                    <div className="flex items-center gap-2 h-[34px]">
                      <input
                        type="checkbox"
                        checked={isPaid}
                        onChange={e => setIsPaid(e.target.checked)}
                        className="w-4 h-4 rounded border-slate-350 text-brand-primary focus:ring-brand-primary cursor-pointer"
                      />
                      <span className="text-slate-600 text-sm">{isPaid ? 'Yes' : 'No'}</span>
                    </div>
                  </label>
                  <label className="flex flex-col cursor-pointer select-none">
                    <span className="text-slate-500 font-semibold mb-1">Affects Balance</span>
                    <div className="flex items-center gap-2 h-[34px]">
                      <input
                        type="checkbox"
                        checked={affectsBalance}
                        onChange={e => setAffectsBalance(e.target.checked)}
                        className="w-4 h-4 rounded border-slate-350 text-brand-primary focus:ring-brand-primary cursor-pointer"
                      />
                      <span className="text-slate-600 text-sm">{affectsBalance ? 'Yes' : 'No'}</span>
                    </div>
                  </label>
                </div>
              )}
            </form>

            {loading ? (
              <div className="py-8 text-center text-slate-500 text-sm">Loading options...</div>
            ) : items.length === 0 ? (
              <div className="py-12 text-center text-slate-400 text-sm border-2 border-dashed border-slate-200 rounded-xl">
                No items found. Add one or seed default values.
              </div>
            ) : (
              <div className="rounded-xl border border-slate-200 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50">
                    <tr className="text-left text-[11px] font-medium text-slate-500 uppercase tracking-wide border-b border-slate-100">
                      <th className="px-3 py-2.5 rounded-tl-xl">Label / Option</th>
                      {libraryType === 'LEAVE_TYPE' && (
                        <>
                          <th className="px-2 py-2.5 text-center whitespace-nowrap">Days</th>
                          <th className="px-2 py-2.5 text-center whitespace-nowrap">Paid</th>
                          <th className="px-2 py-2.5 text-center whitespace-nowrap">Notice</th>
                          <th className="px-2 py-2.5 text-center whitespace-nowrap">Affects Bal.</th>
                          <th className="px-2 py-2.5 text-center whitespace-nowrap">Gender</th>
                        </>
                      )}
                      {libraryType === 'EMPLOYMENT_TYPE' && (
                        <th className="px-2 py-2.5 text-center whitespace-nowrap">Pay Basis</th>
                      )}
                      <th className="px-3 py-2.5 w-[15%] text-center">Status</th>
                      <th className={`py-2.5 rounded-tr-xl text-right ${libraryType === 'LEAVE_TYPE' ? 'px-2 w-10' : 'px-3 w-[15%]'}`}>
                        {libraryType !== 'LEAVE_TYPE' && 'Actions'}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {items.map(item => (
                      <tr key={item.id} className="hover:bg-slate-50 transition-colors">
                        <td className="px-3 py-2.5">
                          {editingItemId === item.id ? (
                            <div className="flex flex-col gap-2">
                              <input
                                type="text"
                                value={editingLabel}
                                onChange={e => setEditingLabel(e.target.value)}
                                className="px-3 py-1 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-brand-primary w-full"
                              />
                              {libraryType === 'LEAVE_TYPE' && (
                                <div className="grid grid-cols-2 gap-2 mt-1 p-2 bg-slate-50 rounded-lg border border-slate-100 text-xs">
                                  <label className="flex flex-col">
                                    <span className="text-slate-500 font-medium">Default Days</span>
                                    <input
                                      type="number"
                                      value={editingDefaultDays}
                                      onChange={e => setEditingDefaultDays(Number(e.target.value))}
                                      className="mt-1 px-2 py-1 border border-slate-200 rounded text-sm bg-white"
                                    />
                                  </label>
                                  <label className="flex flex-col">
                                    <span className="text-slate-500 font-medium">Notice Days</span>
                                    <input
                                      type="number"
                                      value={editingRequiresNoticeDays}
                                      onChange={e => setEditingRequiresNoticeDays(Number(e.target.value))}
                                      className="mt-1 px-2 py-1 border border-slate-200 rounded text-sm bg-white"
                                    />
                                  </label>
                                  <div className="flex flex-col col-span-2">
                                    <span className="text-slate-500 font-medium mb-1">Gender Restriction</span>
                                    <div className="flex gap-1">
                                      {[
                                        { value: '', label: 'All', active: 'bg-slate-200 text-slate-700', inactive: 'bg-white text-slate-400 border border-slate-200' },
                                        { value: 'MALE', label: 'Male', active: 'bg-blue-100 text-blue-600 border border-blue-300', inactive: 'bg-white text-slate-400 border border-slate-200' },
                                        { value: 'FEMALE', label: 'Female', active: 'bg-pink-100 text-pink-600 border border-pink-300', inactive: 'bg-white text-slate-400 border border-slate-200' },
                                      ].map(opt => (
                                        <button
                                          key={opt.value}
                                          type="button"
                                          onClick={() => setEditingGenderRestriction(opt.value)}
                                          className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all ${editingGenderRestriction === opt.value ? opt.active : opt.inactive}`}
                                        >
                                          {opt.label}
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                  <label className="flex items-center gap-1.5 mt-2 select-none cursor-pointer">
                                    <input
                                      type="checkbox"
                                      checked={editingIsPaid}
                                      onChange={e => setEditingIsPaid(e.target.checked)}
                                    />
                                    <span className="text-slate-655 font-medium">Is Paid</span>
                                  </label>
                                  <label className="flex items-center gap-1.5 mt-2 select-none cursor-pointer">
                                    <input
                                      type="checkbox"
                                      checked={editingAffectsBalance}
                                      onChange={e => setEditingAffectsBalance(e.target.checked)}
                                    />
                                    <span className="text-slate-655 font-medium">Affects Balance</span>
                                  </label>
                                </div>
                              )}
                              {libraryType === 'EMPLOYMENT_TYPE' && (
                                <div className="flex gap-1">
                                  {[
                                    { value: '' as const, label: 'Not set' },
                                    { value: 'MONTHLY' as const, label: 'Monthly' },
                                    { value: 'DAILY' as const, label: 'Daily' },
                                  ].map(opt => (
                                    <button
                                      key={opt.value || 'none'}
                                      type="button"
                                      onClick={() => setEditingPayBasis(opt.value)}
                                      className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all ${editingPayBasis === opt.value
                                          ? 'bg-brand-primary text-white'
                                          : 'bg-white text-slate-500 border border-slate-200'
                                        }`}
                                    >
                                      {opt.label}
                                    </button>
                                  ))}
                                </div>
                              )}
                              <div className="flex gap-2 mt-1">
                                <button
                                  onClick={() => handleSaveEdit(item.id)}
                                  className="text-xs px-2.5 py-1 bg-status-success-bg text-status-success hover:bg-status-success/20 rounded-md border border-status-success/30 font-medium"
                                >
                                  Save
                                </button>
                                <button
                                  onClick={() => setEditingItemId(null)}
                                  className="text-xs px-2.5 py-1 bg-slate-50 text-slate-650 hover:bg-slate-100 rounded-md border border-slate-200"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <span className={`font-medium ${item.isActive ? 'text-slate-800' : 'text-slate-400 line-through'}`}>
                              {item.label}
                            </span>
                          )}
                        </td>
                        {libraryType === 'LEAVE_TYPE' && (
                          <>
                            <td className="px-2 py-2.5 text-center text-slate-650 font-medium">
                              {item.defaultDays !== undefined && item.defaultDays !== null ? item.defaultDays : '0'}
                            </td>
                            <td className="px-2 py-2.5 text-center">
                              {item.isPaid ? (
                                <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-semibold bg-status-success-bg/30 text-status-success border border-status-success/20">Paid</span>
                              ) : (
                                <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-semibold bg-status-error-bg text-status-error border border-status-error/20">Unpaid</span>
                              )}
                            </td>
                            <td className="px-2 py-2.5 text-center text-slate-650 font-medium">
                              {item.requiresNoticeDays !== undefined && item.requiresNoticeDays !== null ? item.requiresNoticeDays : '0'}
                            </td>
                            <td className="px-2 py-2.5 text-center">
                              {item.affectsBalance ? (
                                <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-semibold bg-status-success-bg text-status-success border border-status-success/20">Yes</span>
                              ) : (
                                <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-500 border border-slate-200">No</span>
                              )}
                            </td>
                            <td className="px-2 py-2.5 text-center">
                              {item.genderRestriction === 'FEMALE' ? (
                                <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-semibold bg-pink-100 text-pink-600 border border-pink-300">Female</span>
                              ) : item.genderRestriction === 'MALE' ? (
                                <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-100 text-blue-600 border border-blue-300">Male</span>
                              ) : (
                                <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-500 border border-slate-200">All</span>
                              )}
                            </td>
                          </>
                        )}
                        {libraryType === 'EMPLOYMENT_TYPE' && (
                          <td className="px-2 py-2.5 text-center">
                            {item.payBasis === 'DAILY' ? (
                              <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-700 border border-amber-300">Daily</span>
                            ) : item.payBasis === 'MONTHLY' ? (
                              <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-100 text-blue-600 border border-blue-300">Monthly</span>
                            ) : (
                              <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-500 border border-slate-200">—</span>
                            )}
                          </td>
                        )}
                        <td className="px-3 py-2.5 text-center">
                          <button
                            type="button"
                            onClick={() => handleToggleActive(item.id, item.isActive)}
                            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold ${item.isActive
                                ? 'bg-status-success-bg/30 text-status-success border border-status-success/20'
                                : 'bg-slate-100 text-slate-500 border border-slate-200'
                              }`}
                          >
                            <span className={`w-1.5 h-1.5 rounded-full ${item.isActive ? 'bg-status-success' : 'bg-slate-400'}`}></span>
                            {item.isActive ? 'Active' : 'Disabled'}
                          </button>
                        </td>
                        <td className="px-2 py-2.5">
                          {editingItemId !== item.id && (
                            libraryType === 'LEAVE_TYPE' ? (
                              <div className="flex items-center justify-end">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (openMenuId === item.id) {
                                      setOpenMenuId(null);
                                      setMenuPosition(null);
                                    } else {
                                      const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
                                      setMenuPosition({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
                                      setOpenMenuId(item.id);
                                    }
                                  }}
                                  className="p-1 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
                                  title="More actions"
                                >
                                  <MoreVertical size={15} />
                                </button>
                                {openMenuId === item.id && menuPosition && (
                                  <div
                                    style={{ position: 'fixed', top: menuPosition.top, right: menuPosition.right, zIndex: 9999 }}
                                    className="w-32 bg-white border border-slate-200 rounded-xl shadow-lg py-1"
                                  >
                                    <button
                                      onClick={() => { handleStartEdit(item); setOpenMenuId(null); setMenuPosition(null); }}
                                      className="w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 flex items-center gap-2 rounded-t-xl"
                                    >
                                      <Edit3 size={14} />
                                      Edit
                                    </button>
                                    <button
                                      onClick={() => { handleDeleteItem(item.id); setOpenMenuId(null); setMenuPosition(null); }}
                                      className="w-full text-left px-3 py-2 text-sm text-status-error hover:bg-status-error-bg/30 flex items-center gap-2 rounded-b-xl"
                                    >
                                      <Trash2 size={14} />
                                      Delete
                                    </button>
                                  </div>
                                )}
                              </div>
                            ) : (
                              <div className="flex items-center justify-end gap-2">
                                <button
                                  onClick={() => handleStartEdit(item)}
                                  className="p-1 text-slate-450 hover:text-brand-primary hover:bg-slate-100 rounded-lg transition-colors"
                                  title="Edit"
                                >
                                  <Edit3 size={15} />
                                </button>
                                <button
                                  onClick={() => handleDeleteItem(item.id)}
                                  className="p-1 text-slate-450 hover:text-status-error hover:bg-status-error-bg/30 rounded-lg transition-colors"
                                  title="Delete"
                                >
                                  <Trash2 size={15} />
                                </button>
                              </div>
                            )
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

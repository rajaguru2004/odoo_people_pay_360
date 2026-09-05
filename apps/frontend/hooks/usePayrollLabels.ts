'use client';

import { useQuery } from '@tanstack/react-query';
import systemSettingsService from '@/services/systemSettingsService';

/**
 * What this install calls its statutory deductions.
 *
 * The same country switch was written out by hand in five places — the payslip
 * list, the run detail, my-payslip detail, the contract form and the onboarding
 * stepper — so an install that added a country got the new label on some
 * screens and "Insurance" on the others. One reader, one map.
 *
 * `payroll_label_pf` / `payroll_label_income_tax` are admin overrides and win
 * over the country default, which is the behaviour every existing copy already
 * had; this only stops them drifting apart.
 */

/** Country → the words the regulator uses. Keyed on `payroll_country`. */
export const STATUTORY_LABELS: Record<string, { pf: string; tax: string }> = {
  IN: { pf: 'EPF', tax: 'Income Tax / TDS' },
  US: { pf: 'FICA', tax: 'Federal Tax' },
  GB: { pf: 'National Insurance', tax: 'Income Tax (PAYE)' },
  AE: { pf: 'GPSSA', tax: 'Income Tax' },
  SG: { pf: 'CPF', tax: 'Income Tax' },
  DE: { pf: 'Social Security', tax: 'Income Tax' },
  OM: { pf: 'SPF', tax: 'Income Tax' },
};

const FALLBACK = { pf: 'Insurance', tax: 'Personal income tax' };

export interface PayrollLabels {
  /** `SPF` in Oman, `EPF` in India — the statutory employee contribution. */
  pf: string;
  /** `Income Tax` — whatever this country's payslip calls the tax line. */
  tax: string;
  /** `payroll_country`, uppercased. `''` when settings could not be read. */
  country: string;
  loading: boolean;
}

export function usePayrollLabels(): PayrollLabels {
  const q = useQuery({
    queryKey: ['systemSettings', 'public', 'payroll-labels'],
    queryFn: () => systemSettingsService.getPublic(),
    staleTime: 120_000,
  });

  const data = q.data?.data ?? {};
  const country = (data['payroll_country'] ?? '').toUpperCase();
  const defaults = STATUTORY_LABELS[country] ?? FALLBACK;

  return {
    pf: data['payroll_label_pf']?.trim() || defaults.pf,
    tax: data['payroll_label_income_tax']?.trim() || defaults.tax,
    country,
    loading: q.isLoading,
  };
}

export default usePayrollLabels;

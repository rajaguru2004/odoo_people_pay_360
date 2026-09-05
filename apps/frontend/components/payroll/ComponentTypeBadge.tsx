import { Badge } from '@/components/ui/Badge';
import type { SalaryComponentType } from '@/types/payroll';

/**
 * What a salary component DOES, said in one word.
 *
 * The three types are not three styles of the same thing: an earning is added
 * to gross, a deduction is taken off it, and an employer contribution never
 * touches the employee's pay at all. A reader scanning a catalogue or a
 * structure has to be able to tell them apart without reading the amount, so
 * each keeps its own tone everywhere it appears.
 */
export const COMPONENT_TYPE_LABEL: Record<SalaryComponentType, string> = {
  EARNING: 'Earning',
  DEDUCTION: 'Deduction',
  EMPLOYER_CONTRIBUTION: 'Employer contribution',
};

/** Shorter, for a table cell that also has to fit an amount beside it. */
export const COMPONENT_TYPE_SHORT: Record<SalaryComponentType, string> = {
  EARNING: 'Earning',
  DEDUCTION: 'Deduction',
  EMPLOYER_CONTRIBUTION: 'Employer',
};

const TONE: Record<SalaryComponentType, 'success' | 'error' | 'info'> = {
  EARNING: 'success',
  DEDUCTION: 'error',
  // Neither green nor red on purpose. It is money the company spends and the
  // employee never receives, so colouring it as pay or as a loss to them would
  // be the wrong claim in both directions.
  EMPLOYER_CONTRIBUTION: 'info',
};

/** The order every picker and every grouped table lists them in. */
export const COMPONENT_TYPES: SalaryComponentType[] = [
  'EARNING',
  'DEDUCTION',
  'EMPLOYER_CONTRIBUTION',
];

/**
 * A label for a type that may not be one of the three.
 *
 * `type` arrives from the API, and a component created through a later release
 * could carry a value this build has never heard of. Printing the raw enum is
 * ugly but truthful; falling back to "Earning" would put an unknown amount in
 * the gross column.
 */
export function componentTypeLabel(type: string | null | undefined): string {
  if (!type) return '—';
  return COMPONENT_TYPE_LABEL[type as SalaryComponentType] ?? type;
}

export default function ComponentTypeBadge({
  type,
  short = false,
}: {
  type: SalaryComponentType;
  short?: boolean;
}) {
  const label = short
    ? (COMPONENT_TYPE_SHORT[type] ?? type)
    : componentTypeLabel(type);

  return <Badge tone={TONE[type] ?? 'neutral'}>{label}</Badge>;
}

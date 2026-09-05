import type { ContractStatus, ContractType, WorkType } from '@/types/contract';

export type Tone = 'neutral' | 'success' | 'warning' | 'error' | 'info';

export const CONTRACT_STATUS_TONE: Record<ContractStatus, Tone> = {
  DRAFT: 'neutral',
  ACTIVE: 'success',
  EXPIRED: 'warning',
  TERMINATED: 'error',
  RENEWED: 'info',
};

export const CONTRACT_STATUS_OPTIONS: ContractStatus[] = [
  'DRAFT',
  'ACTIVE',
  'EXPIRED',
  'TERMINATED',
  'RENEWED',
];

export const CONTRACT_TYPE_OPTIONS: ContractType[] = [
  'PERMANENT',
  'FIXED_TERM',
  'PROBATION',
  'PART_TIME',
  'INTERNSHIP',
  'CONSULTANT',
];

export const WORK_TYPE_OPTIONS: WorkType[] = ['FULL_TIME', 'PART_TIME', 'REMOTE', 'HYBRID'];

/** Title case from a SCREAMING_SNAKE enum, for a column the reader has to scan. */
export function humanise(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ');
}

export interface ContractFilters {
  search: string;
  status: ContractStatus | '';
  contractType: ContractType | '';
  workType: WorkType | '';
  /** Empty means no countdown filter at all, not a window of zero days. */
  expiringWithinDays: string;
}

export const EMPTY_CONTRACT_FILTERS: ContractFilters = {
  search: '',
  status: '',
  contractType: '',
  workType: '',
  expiringWithinDays: '',
};

/**
 * How many narrowing choices are folded behind the Filters button.
 *
 * The search term is excluded: it has its own always-visible box, so counting
 * it would put a badge on a button that hides nothing.
 */
export function activeContractFilterCount(filters: ContractFilters): number {
  let count = 0;
  if (filters.status) count += 1;
  if (filters.contractType) count += 1;
  if (filters.workType) count += 1;
  if (filters.expiringWithinDays) count += 1;
  return count;
}

/**
 * The subset of the filters the API can answer.
 *
 * `workType` is not a query parameter on the contracts endpoint, so it is
 * applied to the page that comes back instead — which is why it is separated
 * here rather than spread blindly into the request. Sending it would be a 400:
 * the validation pipe runs with `forbidNonWhitelisted`.
 */
export function toContractQuery(filters: ContractFilters) {
  const days = Number(filters.expiringWithinDays);
  return {
    search: filters.search.trim() || undefined,
    status: filters.status || undefined,
    contractType: filters.contractType || undefined,
    expiringWithinDays: Number.isFinite(days) && days > 0 ? days : undefined,
  };
}

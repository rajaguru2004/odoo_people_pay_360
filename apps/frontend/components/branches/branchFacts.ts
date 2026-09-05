import type { Branch } from '@/types/branch';

/** ISO weekday numbers, 1 = Monday — the convention the API stores. */
export const WEEKDAY_LABELS: Record<number, string> = {
  1: 'Mon',
  2: 'Tue',
  3: 'Wed',
  4: 'Thu',
  5: 'Fri',
  6: 'Sat',
  7: 'Sun',
};

/**
 * Whether a fence would actually apply.
 *
 * `geofencingEnabled` on its own is only an intention: without a centre and a
 * radius there is nothing for a check-in to be inside or outside of, so the
 * server lets the clock-in through. Counting those branches as "geofenced"
 * would put a reassuring figure on the hub for a control that is not running.
 */
export function hasCompleteFence(branch: Branch): boolean {
  if (!branch.geofencingEnabled) return false;
  return (
    branch.latitude !== null &&
    branch.latitude !== undefined &&
    branch.longitude !== null &&
    branch.longitude !== undefined &&
    !!branch.geofenceRadiusM
  );
}

/** A fence switched on but left without a centre — worth naming on the card. */
export function hasIncompleteFence(branch: Branch): boolean {
  return !!branch.geofencingEnabled && !hasCompleteFence(branch);
}

/** "Muscat, OM" from whichever address parts exist. */
export function branchLocation(branch: Branch): string | null {
  const parts = [branch.city, branch.state, branch.country].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

/** The wall-clock office window, or null when the branch inherits the company one. */
export function officeWindow(branch: Branch): string | null {
  if (!branch.officeStartTime || !branch.officeEndTime) return null;
  return `${branch.officeStartTime} – ${branch.officeEndTime}`;
}

export function weeklyOff(branch: Branch): string | null {
  if (!branch.weeklyOffDays?.length) return null;
  return branch.weeklyOffDays.map((day) => WEEKDAY_LABELS[day] ?? String(day)).join(', ');
}

export interface BranchStats {
  total: number;
  active: number;
  geofenced: number;
  employees: number;
}

/** The four figures above the list, counted across every branch the reader loaded. */
export function branchStats(branches: Branch[]): BranchStats {
  return {
    total: branches.length,
    active: branches.filter((branch) => branch.isActive).length,
    geofenced: branches.filter(hasCompleteFence).length,
    employees: branches.reduce((sum, branch) => sum + (branch._count?.employees ?? 0), 0),
  };
}

export type BranchStatusFilter = 'all' | 'active' | 'retired';
export type BranchFenceFilter = 'all' | 'fenced' | 'unfenced';

export interface BranchFilters {
  search: string;
  status: BranchStatusFilter;
  country: string;
  fence: BranchFenceFilter;
}

/**
 * Where the panel starts.
 *
 * `active` rather than `all`: a retired branch has no detail page and no place
 * in a working directory, so it is opt-in. The stats bar still counts every
 * branch, which is what makes "3 total, 2 active" a sentence rather than a
 * contradiction with the list underneath it.
 */
export const EMPTY_BRANCH_FILTERS: BranchFilters = {
  search: '',
  status: 'active',
  country: '',
  fence: 'all',
};

/**
 * How many narrowing choices are in force — what the Filters button counts.
 *
 * Measured against the defaults above, not against "no filter at all": the
 * badge exists to reveal choices folded away behind the button, and a screen
 * that opens showing a 1 has taught the reader to ignore it by the second
 * visit.
 */
export function activeBranchFilterCount(filters: BranchFilters): number {
  let count = 0;
  if (filters.status !== EMPTY_BRANCH_FILTERS.status) count += 1;
  if (filters.country) count += 1;
  if (filters.fence !== EMPTY_BRANCH_FILTERS.fence) count += 1;
  return count;
}

export function filterBranches(branches: Branch[], filters: BranchFilters): Branch[] {
  const needle = filters.search.trim().toLowerCase();

  return branches.filter((branch) => {
    if (filters.status === 'active' && !branch.isActive) return false;
    if (filters.status === 'retired' && branch.isActive) return false;
    if (filters.country && branch.country !== filters.country) return false;
    if (filters.fence === 'fenced' && !hasCompleteFence(branch)) return false;
    if (filters.fence === 'unfenced' && hasCompleteFence(branch)) return false;
    if (!needle) return true;

    return [branch.name, branch.code, branch.city, branch.state, branch.country, branch.description]
      .filter((field): field is string => !!field)
      .some((field) => field.toLowerCase().includes(needle));
  });
}

/** The countries actually present, so the filter never offers an empty result. */
export function branchCountries(branches: Branch[]): string[] {
  return [...new Set(branches.map((branch) => branch.country).filter((c): c is string => !!c))].sort();
}

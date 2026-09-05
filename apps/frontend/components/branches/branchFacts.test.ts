import { describe, expect, it } from 'vitest';
import {
  activeBranchFilterCount,
  branchCountries,
  branchStats,
  EMPTY_BRANCH_FILTERS,
  filterBranches,
  hasCompleteFence,
  hasIncompleteFence,
  officeWindow,
} from './branchFacts';
import type { Branch } from '@/types/branch';

function branch(overrides: Partial<Branch> = {}): Branch {
  return {
    id: overrides.code ?? 'b1',
    code: 'HQ',
    name: 'Head Office',
    isActive: true,
    weeklyOffDays: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const FENCED = branch({
  code: 'HQ',
  geofencingEnabled: true,
  latitude: '23.5880000',
  longitude: '58.3829000',
  geofenceRadiusM: 150,
  _count: { employees: 12, departments: 5 },
});

const INTENT_ONLY = branch({
  code: 'SOH',
  name: 'Sohar Plant',
  country: 'OM',
  geofencingEnabled: true,
  _count: { employees: 8, departments: 2 },
});

describe('hasCompleteFence', () => {
  it('needs a centre and a radius, not just the switch', () => {
    // The server lets a clock-in through when there is nothing to be outside
    // of, so counting this branch as fenced reports a control that is not on.
    expect(hasCompleteFence(FENCED)).toBe(true);
    expect(hasCompleteFence(INTENT_ONLY)).toBe(false);
    expect(hasIncompleteFence(INTENT_ONLY)).toBe(true);
  });

  it('treats a zero radius as no fence at all', () => {
    expect(
      hasCompleteFence(branch({ ...FENCED, geofenceRadiusM: 0 })),
    ).toBe(false);
  });

  it('is false when the switch is off, however complete the coordinates', () => {
    expect(hasCompleteFence(branch({ ...FENCED, geofencingEnabled: false }))).toBe(false);
    expect(hasIncompleteFence(branch({ ...FENCED, geofencingEnabled: false }))).toBe(false);
  });
});

describe('branchStats', () => {
  it('counts only branches whose fence would actually apply', () => {
    const stats = branchStats([FENCED, INTENT_ONLY, branch({ code: 'OLD', isActive: false })]);

    expect(stats).toEqual({ total: 3, active: 2, geofenced: 1, employees: 20 });
  });
});

describe('officeWindow', () => {
  it('returns null when the branch inherits the company calendar', () => {
    expect(officeWindow(branch())).toBeNull();
    expect(officeWindow(branch({ officeStartTime: '08:00' }))).toBeNull();
    expect(officeWindow(branch({ officeStartTime: '08:00', officeEndTime: '17:00' }))).toBe(
      '08:00 – 17:00',
    );
  });
});

describe('filterBranches', () => {
  const rows = [FENCED, INTENT_ONLY, branch({ code: 'OLD', name: 'Old Depot', isActive: false })];

  it('searches name, code and address alike', () => {
    expect(filterBranches(rows, { ...EMPTY_BRANCH_FILTERS, search: 'sohar' })).toEqual([
      INTENT_ONLY,
    ]);
  });

  it('separates a retired branch from an open one', () => {
    expect(filterBranches(rows, { ...EMPTY_BRANCH_FILTERS, status: 'retired' })).toHaveLength(1);
    expect(filterBranches(rows, { ...EMPTY_BRANCH_FILTERS, status: 'active' })).toHaveLength(2);
  });

  it('filters on the fence that would apply, not the switch', () => {
    expect(filterBranches(rows, { ...EMPTY_BRANCH_FILTERS, fence: 'fenced' })).toEqual([FENCED]);
    expect(
      filterBranches(rows, { ...EMPTY_BRANCH_FILTERS, status: 'all', fence: 'unfenced' }),
    ).toHaveLength(2);
  });

  it('hides a retired branch until the status filter asks for one', () => {
    expect(filterBranches(rows, EMPTY_BRANCH_FILTERS).map((b) => b.code)).toEqual(['HQ', 'SOH']);
  });

  it('counts the narrowing choices without counting the search box or the defaults', () => {
    // The search term is always visible in its own field, and a panel that
    // opens showing a 1 for its own default has taught the reader to ignore
    // the badge by the second visit.
    expect(activeBranchFilterCount(EMPTY_BRANCH_FILTERS)).toBe(0);
    expect(activeBranchFilterCount({ ...EMPTY_BRANCH_FILTERS, search: 'sohar' })).toBe(0);
    expect(
      activeBranchFilterCount({ ...EMPTY_BRANCH_FILTERS, status: 'retired', fence: 'fenced' }),
    ).toBe(2);
  });
});

describe('branchCountries', () => {
  it('offers only the countries that are actually present', () => {
    expect(branchCountries([FENCED, INTENT_ONLY])).toEqual(['OM']);
  });
});

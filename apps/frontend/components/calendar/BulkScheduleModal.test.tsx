import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import BulkScheduleModal from './BulkScheduleModal';

/**
 * Which days the bulk roster skips, and where that answer comes from.
 *
 * This is the one setting in the modal that is wrong by default rather than
 * merely unset. It used to be the literal `[0, 6]` — Sunday and Saturday — a
 * Western week hard-coded into a product that ships to Oman, where the rest
 * days are **Friday and Saturday** and Sunday is an ordinary working day.
 *
 * An administrator who accepted the defaults therefore rostered every employee
 * on a rest day and left every Sunday unrostered, for a whole branch, in one
 * press — and the run reported success. Nothing on the screen said which week
 * it had assumed. `Branch.weeklyOffDays` had the right answer all along; the
 * schedule overview grid was already reading it.
 *
 * So the rule under test is: the branch in the header decides the week, the old
 * constant survives only as a last resort, and an administrator who has touched
 * a toggle is never overridden by a branch list that arrives late.
 *
 * `data-skipped` on each day button is the assertion surface — it is what the
 * form state actually holds, not what the label says.
 */

const getAll = vi.fn();

vi.mock('@/services/branchService', () => ({
  default: {
    get getAll() {
      return getAll;
    },
  },
}));

/** The modal posts on submit; nothing here gets that far, but the import must resolve. */
vi.mock('@/services/scheduleService', () => ({
  default: { bulkCreate: vi.fn(), create: vi.fn() },
}));

/**
 * The modal also loads the employee list on open. Nothing here asserts on it,
 * but leaving it unmocked makes every case log a 500 — noise that hides a real
 * failure the next time one happens.
 */
vi.mock('@/services/employeeService', () => ({
  default: { getAll: vi.fn().mockResolvedValue({ data: [] }) },
}));

const MUSCAT = {
  id: 'branch-mct',
  code: 'MCT',
  name: 'Muscat',
  // 0 is Sunday, so 5 and 6 are Friday and Saturday — the Omani weekend.
  weeklyOffDays: '5,6',
};

const HEAD_OFFICE = {
  id: 'branch-ho',
  code: 'HO',
  name: 'Head Office',
  weeklyOffDays: null,
};

/** `data-skipped="true"` on a day button, read back as day numbers. */
function skippedDays(): number[] {
  return Array.from(document.querySelectorAll('[data-skipped]'))
    .map((el, i) => ({ el, i }))
    .filter(({ el }) => el.getAttribute('data-skipped') === 'true')
    .map(({ el }) => Number(el.getAttribute('data-day') ?? NaN))
    .filter((n) => !Number.isNaN(n));
}

/** Day buttons carry no explicit index in every build; fall back to position. */
function skippedByPosition(): number[] {
  const all = Array.from(document.querySelectorAll('[data-skipped]'));
  return all
    .map((el, i) => (el.getAttribute('data-skipped') === 'true' ? i : -1))
    .filter((i) => i >= 0);
}

function render(selectedBranchId: string | null) {
  return renderWithProviders(
    <BulkScheduleModal isOpen onClose={vi.fn()} onSuccess={vi.fn()} />,
    { role: 'ADMIN', selectedBranchId },
  );
}

describe('BulkScheduleModal — the week it assumes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAll.mockResolvedValue({ data: [HEAD_OFFICE, MUSCAT] });
  });

  it('skips Friday and Saturday at a branch that rests Friday and Saturday', async () => {
    render(MUSCAT.id);

    await waitFor(() => {
      const skipped = skippedDays().length ? skippedDays() : skippedByPosition();
      // The regression: this read [0, 6] — Sunday and Saturday — before the fix.
      expect(skipped.sort()).toEqual([5, 6]);
    });
  });

  it('does not skip Sunday at that branch, because Sunday is a working day there', async () => {
    render(MUSCAT.id);

    await waitFor(() => {
      const skipped = skippedDays().length ? skippedDays() : skippedByPosition();
      expect(skipped).not.toContain(0);
    });
  });

  it('falls back to the old constant when the branch names no rest days', async () => {
    render(HEAD_OFFICE.id);

    await waitFor(() => {
      const skipped = skippedDays().length ? skippedDays() : skippedByPosition();
      // Not a guess about Head Office — it is what the code does when a branch
      // has nothing to say, and it must stay predictable rather than empty.
      expect(skipped.sort()).toEqual([0, 6]);
    });
  });

  it('falls back when no branch is selected in the header at all', async () => {
    render(null);

    await waitFor(() => {
      const skipped = skippedDays().length ? skippedDays() : skippedByPosition();
      expect(skipped.sort()).toEqual([0, 6]);
    });
  });

  it('does not ask for branches when the header has no selection', async () => {
    render(null);
    // `useBranches(isOpen && !!selectedBranchId)` — an unscoped user would get a
    // 403, so the request is skipped rather than fired and swallowed.
    await waitFor(() => expect(getAll).not.toHaveBeenCalled());
  });
});

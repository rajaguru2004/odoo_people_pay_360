/**
 * Status presentation.
 *
 * The bug this guards: the list page carried its own map covering five of the
 * twelve statuses, so ACTIVE, DISBURSED, ON_HOLD, WRITTEN_OFF, SETTLED, CLOSED,
 * RECEIVABLE and DRAFT all fell through to the CANCELLED style and rendered
 * their raw enum name. A written-off loan and a cancelled request — opposite
 * facts about company money — looked identical.
 *
 * So the tests below are not "does it return a string". They assert the two
 * properties that actually failed: every status in the union is described, and
 * statuses that mean different things do not look the same.
 */
import { describe, it, expect } from 'vitest';
import {
  LOAN_STATUS,
  LOAN_STATUS_FILTERS,
  loanStatusClass,
  loanStatusLabel,
  loanStatusMeta,
  scheduleStatusClass,
  scheduleStatusLabel,
} from './loanStatus';
import { AdvanceLoanStatus, LoanScheduleStatus } from '@/types/advanceLoan';

/** Mirrors the union in types/advanceLoan.ts. */
const ALL_STATUSES: AdvanceLoanStatus[] = [
  'DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'DISBURSED',
  'ACTIVE', 'ON_HOLD', 'CLOSED', 'WRITTEN_OFF', 'RECEIVABLE', 'SETTLED',
  'COMPLETED',
];

const ALL_SCHEDULE_STATUSES: LoanScheduleStatus[] = [
  'SCHEDULED', 'PARTIAL', 'PAID', 'DEFERRED', 'SKIPPED', 'WAIVED',
  'WRITTEN_OFF', 'CLOSED_EARLY', 'CANCELLED',
];

describe('every loan status is described', () => {
  it.each(ALL_STATUSES)('%s has a human label, a tone and a hint', (status) => {
    const meta = LOAN_STATUS[status];
    expect(meta).toBeDefined();

    // Never the raw enum leaking through.
    expect(meta.label).not.toMatch(/_/);
    expect(meta.label).not.toBe(status);
    expect(meta.label.length).toBeGreaterThan(2);

    expect(meta.hint.length).toBeGreaterThan(10);
    expect(meta.hint).toMatch(/[.!]$/);
  });

  it('covers the union exactly — no missing and no invented statuses', () => {
    expect(Object.keys(LOAN_STATUS).sort()).toEqual([...ALL_STATUSES].sort());
  });
});

describe('statuses that mean different things do not look the same', () => {
  it('THE BUG: a written-off loan is not styled like a cancelled one', () => {
    expect(loanStatusClass('WRITTEN_OFF')).not.toBe(loanStatusClass('CANCELLED'));
    expect(loanStatusLabel('WRITTEN_OFF')).toBe('Written off');
    expect(loanStatusLabel('CANCELLED')).toBe('Cancelled');
  });

  it('the statuses the old map dropped now render properly', () => {
    // Each of these previously showed as grey + raw enum text.
    const dropped: AdvanceLoanStatus[] = [
      'ACTIVE', 'DISBURSED', 'ON_HOLD', 'WRITTEN_OFF',
      'SETTLED', 'CLOSED', 'RECEIVABLE', 'DRAFT',
    ];
    const cancelledClass = loanStatusClass('CANCELLED');
    for (const s of dropped) {
      expect(loanStatusLabel(s)).not.toContain('_');
      if (s !== 'DRAFT') {
        // DRAFT is legitimately neutral like CANCELLED; the rest are not.
        expect(loanStatusClass(s)).not.toBe(cancelledClass);
      }
    }
  });

  it('a live loan reads as live and a rejected one as an error', () => {
    expect(loanStatusClass('ACTIVE')).toContain('success');
    expect(loanStatusClass('REJECTED')).toContain('error');
    expect(loanStatusClass('ON_HOLD')).toContain('warning');
    expect(loanStatusClass('COMPLETED')).toContain('info');
  });
});

describe('unknown statuses degrade instead of breaking', () => {
  it('title-cases a status this bundle has never heard of', () => {
    // A server that gains a status before the frontend redeploys must still
    // render something a human can read.
    expect(loanStatusLabel('SOME_NEW_STATUS')).toBe('Some new status');
    expect(loanStatusClass('SOME_NEW_STATUS')).toBe(loanStatusClass('CANCELLED'));
    expect(loanStatusMeta('SOME_NEW_STATUS').hint).toBe('');
  });

  it('never throws or emits undefined for junk input', () => {
    for (const junk of ['', ' ', 'null', 'undefined']) {
      expect(() => loanStatusLabel(junk)).not.toThrow();
      expect(loanStatusClass(junk)).toBeTruthy();
      expect(loanStatusLabel(junk)).not.toContain('undefined');
    }
  });
});

describe('schedule row statuses', () => {
  it.each(ALL_SCHEDULE_STATUSES)('%s has a readable label', (status) => {
    expect(scheduleStatusLabel(status)).not.toMatch(/_/);
    expect(scheduleStatusClass(status)).toBeTruthy();
  });

  it('distinguishes paid from written off', () => {
    expect(scheduleStatusClass('PAID')).not.toBe(scheduleStatusClass('WRITTEN_OFF'));
  });

  it('degrades on an unknown row status', () => {
    expect(scheduleStatusLabel('BRAND_NEW')).toBe('Brand new');
  });
});

describe('list filter groups', () => {
  it('every filter value is a CSV of real statuses', () => {
    for (const f of LOAN_STATUS_FILTERS) {
      if (!f.value) continue; // "All"
      for (const part of f.value.split(',')) {
        expect(ALL_STATUSES).toContain(part as AdvanceLoanStatus);
      }
    }
  });

  it('covers every status across the groups, so nothing is unreachable', () => {
    const covered = new Set(
      LOAN_STATUS_FILTERS.flatMap((f) => (f.value ? f.value.split(',') : [])),
    );
    const missing = ALL_STATUSES.filter((s) => !covered.has(s));
    expect(missing).toEqual([]);
  });

  it('starts with an All option that sends no status param', () => {
    expect(LOAN_STATUS_FILTERS[0]).toMatchObject({ key: 'all', value: '' });
  });
});

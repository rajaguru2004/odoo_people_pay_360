import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import OvertimeDetailPage from './page';

/**
 * The overtime detail screen, and the number it was getting wrong in
 * production: a request the list showed with a S$4.00 food allowance rendered
 * here with a blank one, badged REGULAR instead of LATE.
 *
 * The page recomputed the breakdown in the browser from the GLOBAL branding
 * settings. Those settings are not the rules the server used — the employee's
 * Overtime Policy overrides them — so the estimate silently disagreed with the
 * list, and with the payslip. The server now sends its own breakdown as
 * `preview`; the local recompute is only a fallback for a payload without it.
 */

vi.mock('@/services/overtimeService', () => ({
  default: { getById: vi.fn(), approve: vi.fn(), reject: vi.fn(), cancel: vi.fn() },
}));

vi.mock('@/services/approvalWorkflowService', () => ({
  default: { trail: vi.fn() },
}));

vi.mock('@/services/holidayService', () => ({
  default: { getAll: vi.fn(), calculateWorkDays: vi.fn() },
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import overtimeService from '@/services/overtimeService';
import approvalWorkflowService from '@/services/approvalWorkflowService';
import holidayService from '@/services/holidayService';

// Globals say: late/food from 22:00, allowance 150. The request below ends
// exactly at 22:00, so recomputing from these yields REGULAR + no food.
const BRANDING = {
  overtime_regular_rate: '1.5',
  overtime_late_rate: '1.5',
  overtime_double_rate: '2.0',
  overtime_late_threshold: '22:00',
  overtime_food_allowance_enabled: true,
  overtime_food_allowance_amount: '150',
  overtime_food_allowance_threshold: '22:00',
  attendance_day_end_time: '23:59',
  payroll_work_hours_per_day: '8',
} as never;

const REQUEST = {
  id: 'ot-1',
  employeeId: 'emp-1',
  date: '2026-08-18T00:00:00.000Z',
  startTime: '2026-08-18T17:30:00.000Z',
  endTime: '2026-08-18T22:00:00.000Z',
  hours: 4.5,
  regularHours: 3.5,
  lateHours: 1,
  doubleHours: 0,
  foodAllowance: 4,
  otType: 'LATE',
  reason: 'Line shutdown recovery',
  status: 'PENDING',
  createdAt: '2026-08-18T13:21:43.000Z',
  updatedAt: '2026-08-18T13:21:43.000Z',
  employee: {
    id: 'emp-1',
    employeeCode: 'TRS-POD-002',
    fullName: 'JAMEENRAJ MATHIYAZHAGAN',
    email: 'jemini.tyd@gmail.com',
    baseSalary: 27,
    salaryType: 'DAILY',
    branchId: 'br-ho',
  },
};

// What the server computes under the employee's policy (late + food from 21:00,
// allowance S$4) — the same rules that produced the persisted row.
const SERVER_PREVIEW = {
  hours: 4.5,
  regularHours: 3.5,
  lateHours: 1,
  doubleHours: 0,
  doubleLateHours: 0,
  dayType: 'WEEKDAY',
  foodAllowance: 4,
  otType: 'LATE',
  isDoubleOtDay: false,
  regularRate: 1.5,
  lateRate: 1.5,
  doubleRate: 2,
  doubleLateRate: 2,
  policyId: 'pol-1',
  policyName: 'Projects Ops',
};

// `use(params)` suspends on a pending promise; a fulfilled thenable (the shape
// React itself caches) lets the page render synchronously under the test
// renderer instead of hanging on a Suspense boundary this page does not have.
const resolvedParams = (id: string) => {
  const thenable = Promise.resolve({ id }) as Promise<{ id: string }> & {
    status?: string;
    value?: { id: string };
  };
  thenable.status = 'fulfilled';
  thenable.value = { id };
  return thenable;
};

const renderDetail = () =>
  renderWithProviders(<OvertimeDetailPage params={resolvedParams('ot-1')} />, {
    role: 'ADMIN',
    branding: BRANDING,
  });

const breakdown = () => document.querySelector('[data-testid="ot-breakdown"]') as HTMLElement;

beforeEach(() => {
  vi.mocked(approvalWorkflowService.trail).mockResolvedValue({ success: true, data: null } as never);
  vi.mocked(holidayService.getAll).mockResolvedValue({ success: true, data: [] } as never);
  vi.mocked(holidayService.calculateWorkDays).mockResolvedValue({
    success: true,
    data: { workDays: 26 },
  } as never);
});

describe('the payable breakdown', () => {
  it('shows the food allowance and OT type the server computed, not the one the global settings imply', async () => {
    vi.mocked(overtimeService.getById).mockResolvedValue({
      success: true,
      data: { ...REQUEST, preview: SERVER_PREVIEW },
    } as never);

    renderDetail();
    await waitFor(() => expect(breakdown()).toBeInTheDocument());

    // The defect: a blank allowance here while the list showed S$ 4.00.
    expect(breakdown().getAttribute('data-food-allowance')).toBe('4');
    expect(breakdown().getAttribute('data-ot-type')).toBe('LATE');
    expect(breakdown().textContent).not.toContain('—');
  });

  it('splits the hours across the tiers the server reported', async () => {
    vi.mocked(overtimeService.getById).mockResolvedValue({
      success: true,
      data: { ...REQUEST, preview: SERVER_PREVIEW },
    } as never);

    renderDetail();
    await waitFor(() => expect(breakdown()).toBeInTheDocument());

    const tiers = Array.from(document.querySelectorAll('[data-testid="ot-breakdown-tier"]')).map(
      (el) => [el.getAttribute('data-tier'), el.getAttribute('data-hours')],
    );
    // Global rules would have put all 4.5h in the regular bucket.
    expect(tiers).toEqual([
      ['regular', '3.5'],
      ['late', '1'],
    ]);
    expect(breakdown().getAttribute('data-total-hours')).toBe('4.5');
  });

  it('folds a double day\'s post-threshold hours into the late row at their own multiplier', async () => {
    vi.mocked(overtimeService.getById).mockResolvedValue({
      success: true,
      data: {
        ...REQUEST,
        otType: 'DOUBLE_LATE',
        preview: {
          ...SERVER_PREVIEW,
          dayType: 'SUNDAY',
          isDoubleOtDay: true,
          otType: 'DOUBLE_LATE',
          regularHours: 0,
          lateHours: 0,
          doubleHours: 3.5,
          doubleLateHours: 1,
          doubleRate: 2,
          doubleLateRate: 2.5,
        },
      },
    } as never);

    renderDetail();
    await waitFor(() => expect(breakdown()).toBeInTheDocument());

    const tiers = Array.from(document.querySelectorAll('[data-testid="ot-breakdown-tier"]')).map(
      (el) => [el.getAttribute('data-tier'), el.getAttribute('data-hours')],
    );
    expect(tiers).toEqual([
      ['late', '1'],
      ['double', '3.5'],
    ]);
    // hourly rate 27/8 = 3.375 → 3.5h × 2 + 1h × 2.5 = 9.5 rate-hours, + S$4 food.
    const pay = document.querySelector('[data-testid="ot-pay"]') as HTMLElement;
    expect(Number(pay.getAttribute('data-total'))).toBeCloseTo(3.375 * 9.5 + 4, 2);
  });

  it('falls back to the local estimate when the payload carries no server preview', async () => {
    vi.mocked(overtimeService.getById).mockResolvedValue({
      success: true,
      data: { ...REQUEST },
    } as never);

    renderDetail();
    await waitFor(() => expect(breakdown()).toBeInTheDocument());

    // Global rules: ends exactly at 22:00 → nothing late, no allowance.
    expect(breakdown().getAttribute('data-ot-type')).toBe('REGULAR');
    expect(breakdown().getAttribute('data-food-allowance')).toBe('0');
  });
});

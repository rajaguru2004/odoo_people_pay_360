import { essActions } from './actions/ess.actions';
import { approvalActions } from './actions/approval.actions';
import { navActions } from './actions/nav.actions';
import { RenderCtx, WhatsAppActionDef } from './action.types';
import { buildMainMenu } from '../render/menu-renderer';
import { WA_LIST } from '../render/wa-limits';

/**
 * Every action must produce a message a human can read.
 *
 * The failures this catches are the ones that only ever show up on a handset:
 * a renderer that reaches into a shape the tool does not return and prints
 * `undefined`, an unparsed date that becomes `Invalid Date`, an object that
 * stringifies to `[object Object]`, or an empty bubble.
 *
 * Each action is rendered THREE times — against a rich payload, an empty one,
 * and a null one — because "no data yet" is the state a new employee is
 * actually in, and it is the one nobody tries by hand.
 */

const ctx: RenderCtx = {
  recipientName: 'Raja Guru',
  employeeId: '3f1a2b4c-5d6e-4f70-8a91-b2c3d4e5f607',
  appBaseUrl: 'https://hr.example.com',
  currencySymbol: '₹',
  timeZone: 'Asia/Kolkata',
  args: {},
};

/**
 * A payload with every field any renderer in the catalogue reaches for.
 *
 * One shared object rather than per-action fixtures: a renderer reading a
 * field nobody else uses is exactly the drift worth noticing, and a shared
 * shape makes that visible instead of hiding it behind a bespoke stub.
 */
const RICH = {
  success: true,
  data: {
    checkIn: '2026-08-10T03:30:00.000Z',
    checkOut: '2026-08-10T12:30:00.000Z',
    sessions: [{ checkIn: '2026-08-10T03:30:00.000Z', checkOut: '2026-08-10T12:30:00.000Z' }],
    status: 'PRESENT',
    isLate: false,
    workHours: 8.5,
    overtimeHours: 1,
    balances: [{ leaveType: 'ANNUAL', remaining: 12, used: 3, total: 15 }],
    totalEarnings: 50000,
    totalDeductions: 5000,
    totalNet: 45000,
    monthsPaid: 8,
    loans: [{ loanType: 'Personal', outstanding: 20000, status: 'ACTIVE' }],
    shifts: [
      { date: '2026-08-11', startTime: '2026-08-11T03:30:00.000Z', endTime: '2026-08-11T12:30:00.000Z' },
    ],
    items: [],
  },
};

/** The list form most read tools return. */
const ROWS = [
  {
    id: '9e8d7c6b-5a4f-4e3d-9c2b-1a0f9e8d7c6b',
    leaveType: 'ANNUAL',
    startDate: '2026-09-01',
    endDate: '2026-09-03',
    status: 'PENDING',
    date: '2026-08-01',
    hours: 2,
    month: 8,
    year: 2026,
    netPay: 45000,
    destination: 'Chennai',
    departureDate: '2026-09-10',
    courseName: 'Safety',
    title: 'Laptop',
    assetCode: 'AST-1',
    name: 'Independence Day',
    fullName: 'Asha Menon',
    position: 'Engineer',
    employeeCode: 'EMP-2',
    type: 'Travel',
    amount: 1250,
    requestType: 'LEAVE',
    requesterName: 'Asha Menon',
    outstanding: 20000,
  },
];

const CASES: Array<[string, unknown]> = [
  ['a rich payload', RICH],
  ['a list payload', { success: true, data: ROWS }],
  ['an empty payload', { success: true, data: [] }],
  ['nothing at all', null],
];

/** Strings that mean a renderer leaked an internal into somebody's chat. */
const LEAKS = [
  'undefined',
  'Invalid Date',
  '[object Object]',
  'NaN',
  'Invalid input:',
  'expected string, received',
  'ZodError',
];

const catalogue = [...essActions(), ...approvalActions(), ...navActions()];
const renderable = catalogue.filter((a) => !a.localRender);

describe('every action renders something readable', () => {
  it.each(
    renderable.flatMap((a) =>
      CASES.map(([label, payload]) => [a.key, label, a, payload] as const),
    ),
  )('%s with %s', (_key, _label, action: WhatsAppActionDef, payload) => {
    const out = action.render(payload, ctx);

    expect(typeof out.plain).toBe('string');
    expect(out.plain.trim().length).toBeGreaterThan(0);

    for (const leak of LEAKS) {
      expect(out.plain).not.toContain(leak);
    }

    // A renderer that offers buttons must label every one of them.
    for (const item of out.buttons?.items ?? []) {
      expect(item.label.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('the shipped catalogue fits the surfaces it renders into', () => {
  const employeeActions = catalogue
    .filter((a) => !a.hidden)
    .filter((a) => a.roles.includes('EMPLOYEE'));

  it('has no menu label that a list row would truncate', () => {
    // The row title is the ONLY place a label appears now, so an overflow is
    // permanent rather than cosmetic. Checked against the REAL catalogue, not
    // fixtures, because that is what ships.
    const built = buildMainMenu(employeeActions, {
      title: 'HR services',
      description: 'Pick one.',
      buttonText: 'Open menu',
    });
    const tooLong = built.menu.filter(
      (o) => `${o.n}. ${o.label}`.length > WA_LIST.rowTitle,
    );
    expect(tooLong.map((o) => o.label)).toEqual([]);
  });

  it('gives every visible action a distinct label', () => {
    // Two rows reading the same thing is indistinguishable from the bot
    // repeating itself, which is the complaint that started this file.
    const labels = employeeActions.map((a) => a.menuLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('has no menu label long enough to overflow a button', () => {
    // Next-step buttons reuse menu labels; WhatsApp caps a button at 20 chars.
    const nextStepTargets = new Set(
      catalogue.flatMap((a) =>
        Array.isArray(a.nextSteps) ? a.nextSteps.map((s) => s.label) : [],
      ),
    );
    for (const label of nextStepTargets) {
      expect(label.length).toBeLessThanOrEqual(20);
    }
  });
});

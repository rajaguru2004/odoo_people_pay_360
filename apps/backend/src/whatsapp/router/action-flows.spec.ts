import { essActions } from './actions/ess.actions';
import { approvalActions } from './actions/approval.actions';
import { FlowSlotInput, FlowStepCtx, RenderCtx, WhatsAppActionDef } from './action.types';

/**
 * Multi-step flows, driven the way a person drives them.
 *
 * A flow can pass every other test in this repo and still be unusable: the
 * prompt suggests a format, the parse step rejects it, and the employee is
 * stuck in a loop being told to try again. Nothing else checks that a step
 * ACCEPTS what its own prompt asked for.
 *
 * So each flow is walked start to finish with realistic answers, and each step
 * is also given rubbish to confirm it refuses with a sentence rather than
 * throwing.
 */

const ctx: RenderCtx = {
  recipientName: 'Raja Guru',
  employeeId: '3f1a2b4c-5d6e-4f70-8a91-b2c3d4e5f607',
  appBaseUrl: 'https://hr.example.com',
  currencySymbol: '₹',
  timeZone: 'Asia/Kolkata',
  args: {},
};

const typed = (text: string): FlowSlotInput => ({
  kind: 'text',
  text,
  callbackId: null,
  location: null,
});

/**
 * What a person would plausibly type at each step, keyed by slot.
 *
 * Several answers per slot on purpose — a step that only accepts one exact
 * spelling of a date is a step that fails in the field.
 */
const ANSWERS: Record<string, string[]> = {
  leaveType: ['1', 'ANNUAL', 'annual'],
  // RELATIVE, not fixed dates: each answer is tested against slots seeded with
  // the FIRST answer of the preceding steps, so a hardcoded endDate would
  // start failing the day the fixture drifts into the past — a test that
  // breaks on a calendar rather than on a regression.
  startDate: ['tomorrow', 'day after tomorrow'],
  endDate: ['day after tomorrow', 'tomorrow'],
  reason: ['Family function', 'Sick'],
  search: ['raja', 'Asha Menon'],
  type: ['1', 'Travel', 'Client entertainment'],
  amount: ['1250', '1,250', '1250.50', '₹1250'],
  expenseDate: ['2026-08-01', 'today', 'yesterday'],
  description: ['Client visit cab fare', 'SKIP', 'skip'],
  date: ['2026-08-01', 'yesterday'],
  checkIn: ['09:15', '0915', '9:15', 'SKIP'],
  checkOut: ['18:00', '1800', 'SKIP'],
  comment: ['Looks fine'],
};

/** Input every step must REFUSE, and refuse politely. */
const RUBBISH: Record<string, string[]> = {
  leaveType: ['99', 'purple'],
  startDate: ['not a date', 'x'],
  endDate: ['not a date'],
  reason: ['', 'a'],
  search: ['', 'a'],
  amount: ['abc', '0', '-5'],
  expenseDate: ['not a date'],
  date: ['not a date'],
  checkIn: ['99:99', 'lunchtime'],
  checkOut: ['25:00'],
  comment: [],
  type: [''],
  description: [],
};

const withFlows = [...essActions(), ...approvalActions()].filter((a) => a.flow);

describe('multi-step flows', () => {
  it('there are flows to test', () => {
    expect(withFlows.length).toBeGreaterThanOrEqual(4);
  });

  describe.each(withFlows.map((a) => [a.key, a] as const))('%s', (_key, action: WhatsAppActionDef) => {
    const flow = action.flow!;

    it('every step has a fixture, so this suite cannot pass by omission', () => {
      for (const step of flow.steps) {
        expect(Object.keys(ANSWERS)).toContain(step.slot);
        expect(ANSWERS[step.slot].length).toBeGreaterThan(0);
      }
    });

    it('prompts with a non-empty question at every step', () => {
      const slots: Record<string, unknown> = {};
      for (const step of flow.steps) {
        const stepCtx: FlowStepCtx = { slots, render: ctx };
        const out = step.prompt(stepCtx);
        expect(out.plain.trim().length).toBeGreaterThan(0);
        // A prompt that renders a raw internal is as bad as a broken parse.
        expect(out.plain).not.toContain('undefined');
        expect(out.plain).not.toContain('[object Object]');
        slots[step.slot] = ANSWERS[step.slot][0];
      }
    });

    it('accepts every plausible answer its prompt invites', () => {
      const slots: Record<string, unknown> = {};
      for (const step of flow.steps) {
        const stepCtx: FlowStepCtx = { slots, render: ctx };
        for (const answer of ANSWERS[step.slot]) {
          const res = step.parse(typed(answer), stepCtx);
          if (!res.ok) {
            throw new Error(
              `${action.key} step "${step.slot}" refused a reasonable answer ${JSON.stringify(answer)}: ${res.error}`,
            );
          }
        }
        const first = step.parse(typed(ANSWERS[step.slot][0]), stepCtx);
        if (first.ok) slots[step.slot] = first.value;
      }
    });

    it('refuses rubbish with a sentence, never an exception', () => {
      const slots: Record<string, unknown> = {};
      for (const step of flow.steps) {
        const stepCtx: FlowStepCtx = { slots, render: ctx };
        for (const bad of RUBBISH[step.slot] ?? []) {
          const res = step.parse(typed(bad), stepCtx);
          expect(res.ok).toBe(false);
          if (!res.ok) {
            // The employee has to know what to type next.
            expect(res.error.trim().length).toBeGreaterThan(8);
          }
        }
        // A missing message must not throw either — an attachment mid-flow
        // reaches here with text: null.
        expect(() =>
          step.parse({ kind: 'text', text: null, callbackId: null, location: null }, stepCtx),
        ).not.toThrow();
        slots[step.slot] = ANSWERS[step.slot][0];
      }
    });

    it('builds tool arguments from a completed walk', () => {
      const slots: Record<string, unknown> = {};
      for (const step of flow.steps) {
        const res = step.parse(typed(ANSWERS[step.slot][0]), { slots, render: ctx });
        expect(res.ok).toBe(true);
        if (res.ok) slots[step.slot] = res.value;
      }

      const args = flow.buildArgs(slots);
      expect(Object.keys(args).length).toBeGreaterThan(0);
      // Nothing may arrive at a tool as the literal string "undefined".
      for (const [k, v] of Object.entries(args)) {
        expect(String(v)).not.toBe('undefined');
        expect(k.length).toBeGreaterThan(0);
      }
    });
  });
});

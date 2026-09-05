import { withNextSteps } from './next-steps';
import { RenderCtx, WaOutbound, WhatsAppActionDef, replyBtn } from './action.types';
import { decodeCallback, decodeControl } from './callback-id';

/**
 * Follow-ups are declared on actions rather than hand-rolled by renderers for
 * one reason: they get FILTERED. A target the caller cannot see must stop being
 * offered without anyone editing a renderer.
 */

const ctx: RenderCtx = {
  recipientName: 'Sam',
  employeeId: 'e1',
  appBaseUrl: 'https://hr.example.com',
  currencySymbol: '₹',
  timeZone: 'Asia/Kolkata',
  args: {},
};

const action = (over: Partial<WhatsAppActionDef> = {}): WhatsAppActionDef =>
  ({
    key: 'attendance.checkin',
    menuLabel: 'Check in',
    menuGroup: 'attendance',
    roles: ['EMPLOYEE'],
    requiresEmployee: true,
    sensitivity: 'normal',
    keywords: [],
    confirmPolicy: 'implicit',
    tool: { name: 'attendance_check_in' },
    render: () => ({ plain: 'ok' }),
    nextSteps: [
      { target: 'attendance.lunch_start', label: 'Start lunch' },
      { target: 'attendance.checkout', label: 'Check out' },
    ],
    ...over,
  }) as WhatsAppActionDef;

const base: WaOutbound = { plain: '✅ Checked in' };
const visible = new Set(['attendance.lunch_start', 'attendance.checkout', 'leave.balance']);

describe('withNextSteps', () => {
  it('offers the declared follow-ups plus a way back to the menu', () => {
    const out = withNextSteps(base, action(), {}, ctx, visible);

    expect(out.buttons!.items.map((i) => i.label)).toEqual([
      'Start lunch',
      'Check out',
      'Menu',
    ]);
    const last = out.buttons!.items[2];
    expect(last.kind).toBe('reply');
    expect(decodeControl(decodeCallback((last as any).callbackId)!.actionKey)).toBe('menu');
  });

  it('drops a follow-up the caller cannot see', () => {
    // An action switched off in settings, or gated behind a kill switch, stops
    // being suggested — no renderer edit required.
    const out = withNextSteps(base, action(), {}, ctx, new Set(['attendance.checkout']));
    expect(out.buttons!.items.map((i) => i.label)).toEqual(['Check out', 'Menu']);
  });

  it('honours a conditional follow-up', () => {
    const a = action({
      nextSteps: [
        { target: 'attendance.checkout', label: 'Check out', when: (p: any) => p.checkedIn },
      ],
    });

    const yes = withNextSteps(base, a, { checkedIn: true }, ctx, visible);
    expect(yes.buttons!.items.map((i) => i.label)).toEqual(['Check out', 'Menu']);

    const no = withNextSteps(base, a, { checkedIn: false }, ctx, visible);
    expect(no.buttons!.items.map((i) => i.label)).toEqual(['Menu']);
  });

  it('leaves a renderer that already has buttons completely alone', () => {
    // A confirmation must never be diluted by follow-ups.
    const confirm: WaOutbound = {
      plain: 'Confirm?',
      buttons: {
        title: 'Confirm',
        description: 'Apply?',
        items: [replyBtn('Yes', 'v1|__ctl.yes')],
      },
    };
    expect(withNextSteps(confirm, action(), {}, ctx, visible)).toBe(confirm);
  });

  it('leaves a list-bearing outbound alone', () => {
    const menu: WaOutbound = {
      plain: 'menu',
      list: { title: 't', description: 'd', buttonText: 'b', sections: [] },
    };
    expect(withNextSteps(menu, action(), {}, ctx, visible)).toBe(menu);
  });

  it('renders a link as text, never as a button alongside replies', () => {
    // Evolution refuses a message mixing reply and url buttons, so the link has
    // to survive in the text or it is lost entirely.
    const a = action({
      nextSteps: [
        { target: 'attendance.checkout', label: 'Check out' },
        {
          target: '__link.payroll',
          label: 'Full breakdown',
          url: (c) => `${c.appBaseUrl}/dashboard/my-payroll`,
        },
      ],
    });
    const out = withNextSteps(base, a, {}, ctx, visible);

    expect(out.buttons!.items.every((i) => i.kind === 'reply')).toBe(true);
    expect(out.buttons!.items.map((i) => i.label)).toEqual(['Check out', 'Menu']);
    expect(out.plain).toContain('https://hr.example.com/dashboard/my-payroll');
  });

  it('offers a link even though it names no visible action', () => {
    const a = action({
      nextSteps: [
        { target: '__link.portal', label: 'Open portal', url: (c) => `${c.appBaseUrl}/dashboard` },
      ],
    });
    const out = withNextSteps(base, a, {}, ctx, new Set());
    expect(out.plain).toContain('https://hr.example.com/dashboard');
  });

  it('mirrors the taps into the numbered menu so text-only clients can reply', () => {
    const out = withNextSteps(base, action(), {}, ctx, visible);

    // The MENU control is not numbered — it is a word, not a menu entry.
    expect(out.menu).toEqual([
      { n: 1, label: 'Start lunch', actionKey: 'attendance.lunch_start', params: undefined },
      { n: 2, label: 'Check out', actionKey: 'attendance.checkout', params: undefined },
    ]);
    expect(out.plain).toContain('Next: Start lunch · Check out · Menu');
  });

  it('continues the numbering of a menu the renderer already built', () => {
    const withMenu: WaOutbound = {
      plain: 'list',
      menu: [{ n: 1, label: 'A', actionKey: 'leave.balance' }],
    };
    const out = withNextSteps(withMenu, action(), {}, ctx, visible);
    expect(out.menu!.map((o) => o.n)).toEqual([1, 2, 3]);
  });

  it('never offers more taps than WhatsApp will render', () => {
    const a = action({
      nextSteps: [
        { target: 'attendance.lunch_start', label: 'One' },
        { target: 'attendance.checkout', label: 'Two' },
        { target: 'leave.balance', label: 'Three' },
      ],
    });
    const out = withNextSteps(base, a, {}, ctx, visible);
    expect(out.buttons!.items).toHaveLength(3);
    // Menu lost its place to the third declared step rather than overflowing.
    expect(out.buttons!.items.map((i) => i.label)).toEqual(['One', 'Two', 'Three']);
  });

  it('does nothing for an action that declares no follow-ups', () => {
    const out = withNextSteps(base, action({ nextSteps: undefined }), {}, ctx, visible);
    // Only the standing Menu affordance.
    expect(out.buttons!.items.map((i) => i.label)).toEqual(['Menu']);
  });

  /**
   * The button card renders its OWN title and description and never shows
   * `plain`. Hard-coding a prompt there deleted the reply: on production
   * WhatsApp a successful check-in arrived as nothing but "What next? Pick one,
   * or reply MENU." — no time, no status. It survived because buttons fall back
   * to plain text wherever the account cannot render them, which is where it
   * had been tested.
   */
  describe('the card carries the answer, not a prompt', () => {
    const CONFIRMATION = '*✅ Checked in*\n*Time:* 19:03\n*Status:* PRESENT\n_Marked late._';

    it('puts the result in the card body', () => {
      const out = withNextSteps({ plain: CONFIRMATION }, action(), {}, ctx, visible);
      expect(out.buttons!.description).toContain('19:03');
      expect(out.buttons!.description).toContain('PRESENT');
    });

    it('never renders the old placeholder over a real reply', () => {
      const out = withNextSteps({ plain: CONFIRMATION }, action(), {}, ctx, visible);
      expect(out.buttons!.description).not.toBe('Pick one, or reply MENU.');
      expect(out.buttons!.title).not.toBe('What next?');
    });

    it('uses the first line as the card headline, without its bold markers', () => {
      const out = withNextSteps({ plain: CONFIRMATION }, action(), {}, ctx, visible);
      expect(out.buttons!.title).toBe('✅ Checked in');
    });

    it('keeps the follow-up trailer in the body', () => {
      const out = withNextSteps({ plain: CONFIRMATION }, action(), {}, ctx, visible);
      expect(out.buttons!.description).toContain('Start lunch');
    });

    it('never leaves the body empty for a one-line reply', () => {
      // The headline is stripped from the body; with nothing left, the whole
      // message has to come back rather than an empty card.
      const out = withNextSteps({ plain: '✅ Checked in' }, action(), {}, ctx, visible);
      expect(out.buttons!.description.trim().length).toBeGreaterThan(0);
    });

    it('truncates rather than exceeding the card limits', () => {
      const huge = 'Title line\n' + 'x'.repeat(5000);
      const out = withNextSteps({ plain: huge }, action(), {}, ctx, visible);
      expect(out.buttons!.title.length).toBeLessThanOrEqual(60);
      expect(out.buttons!.description.length).toBeLessThanOrEqual(1024);
    });

    it('still carries the full text in plain, for the text fallback', () => {
      const out = withNextSteps({ plain: CONFIRMATION }, action(), {}, ctx, visible);
      expect(out.plain).toContain('19:03');
      expect(out.plain).toContain('PRESENT');
    });
  });

});

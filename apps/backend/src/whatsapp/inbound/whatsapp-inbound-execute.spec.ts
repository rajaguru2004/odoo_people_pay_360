import { WhatsAppInboundService } from './whatsapp-inbound.service';
import { essActions } from '../router/actions/ess.actions';
import { navActions } from '../router/actions/nav.actions';
import { RenderCtx } from '../router/action.types';

/**
 * execute() is the seam every path converges on — a routed message, a
 * completed flow, a PIN resume — and it is the seam that broke: its signature
 * swapped cfg and ctx, all three callers kept the old order, and the compiler
 * said nothing because cfg was `any`. On a real handset that surfaced as
 * "That section is no longer available" for every menu tap, and follow-up
 * buttons collapsing to a bare "Menu".
 *
 * These tests drive execute() with the REAL catalogue, so an argument-order
 * regression fails here — loudly, with the same symptoms — instead of on
 * somebody's phone.
 */

const CATALOGUE = [...essActions(), ...navActions()];
const byKey = new Map(CATALOGUE.map((a) => [a.key, a]));

function harness() {
  const sent: any[] = [];
  const composer: any = {
    send: jest.fn(async (_session: any, out: any) => {
      sent.push(out);
      return true;
    }),
    renderToolError: jest.fn(() => ({ plain: 'tool error' })),
  };
  const caller: any = {
    call: jest.fn(async () => ({ success: true, data: { checkIn: '2026-08-09T05:00:00.000Z' } })),
  };
  const registry: any = {
    getAll: () => CATALOGUE,
    getByKey: (k: string) => byKey.get(k),
    visibleFor: (role: string, hasEmployee: boolean, disabled: Set<string>) =>
      CATALOGUE.filter(
        (a) =>
          !a.hidden &&
          !disabled.has(a.key) &&
          a.roles.includes(role as any) &&
          (!a.requiresEmployee || hasEmployee),
      ),
  };

  const stub: any = {};
  const svc = new WhatsAppInboundService(
    stub, // prisma
    stub, // settings
    { rememberMenu: jest.fn() } as any, // sessions
    stub, // router
    registry,
    stub, // flows
    stub, // principals
    caller,
    composer,
    stub, // rates
    stub, // tokens
    { log: jest.fn() } as any, // audit
    stub, // tz
    stub, // proofs
    stub, // faceProofs
    stub, // ai
  );
  return { svc, sent, caller, composer };
}

const session: any = { id: 's1', remoteJid: '918608721969@s.whatsapp.net', identityId: 'i1' };
const user: any = { id: 'u1', role: 'EMPLOYEE', employeeId: 'e1' };

/** A real, fully-populated config. What execute's cfg slot must contain. */
const cfg: any = {
  actionDenylist: [],
  approvalsEnabled: true,
  mutationsEnabled: true,
  appBaseUrl: 'https://hr.example.com',
};

/** A real render context. What execute's ctx slot must contain. */
const ctx: RenderCtx = {
  recipientName: 'Raja Guru',
  employeeId: 'e1',
  appBaseUrl: 'https://hr.example.com',
  currencySymbol: '₹',
  timeZone: 'Asia/Kolkata',
  args: {},
};

describe('execute() — the seam all three entry paths share', () => {
  it('opens a section when its row is tapped', async () => {
    // The exact failing interaction from the handset: the Attendance row of
    // the group picker carries `v1|menu.section|g=attendance`, and the decoded
    // params must survive all the way into the local renderer.
    const { svc, sent } = harness();
    await svc.execute(byKey.get('menu.section')!, {}, session, user, cfg, ctx, {
      g: 'attendance',
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].plain).toContain('Attendance');
    expect(sent[0].plain).not.toContain('no longer available');
    expect(sent[0].menu!.map((o: any) => o.actionKey)).toContain('attendance.checkin');
  });

  it('fails soft on a section that does not exist', async () => {
    const { svc, sent } = harness();
    await svc.execute(byKey.get('menu.section')!, {}, session, user, cfg, ctx, { g: 'nope' });
    expect(sent[0].plain).toContain('no longer available');
  });

  it('keeps write follow-ups when mutations are enabled', async () => {
    // The second symptom of the swap: visibleFor() received the RenderCtx,
    // read mutationsEnabled as undefined, disabled every write, and the
    // next-step buttons after a check-in collapsed to a bare "Menu".
    const { svc, sent } = harness();
    await svc.execute(byKey.get('attendance.checkin')!, {}, session, user, cfg, ctx);

    const labels = sent[0].buttons!.items.map((i: any) => i.label);
    expect(labels).toEqual(['Start lunch', 'Check out', 'Menu']);
  });

  it('renders in the caller timezone, not the config', async () => {
    // With the slots swapped, the renderer's ctx was the config: no name, no
    // zone. 05:00Z is 10:30 in Kolkata — assert the conversion happened.
    const { svc, sent } = harness();
    await svc.execute(byKey.get('attendance.checkin')!, {}, session, user, cfg, ctx);
    expect(sent[0].plain).toContain('10:30');
  });

  it('applies derived arguments at the choke point', async () => {
    // payroll.ytd derives the current year. The PIN-resume path rebuilds its
    // arguments from staticArgs alone, so if derivation lived anywhere but
    // execute(), entering a PIN would run the tool with no year at all.
    const { svc, caller } = harness();
    caller.call.mockResolvedValue({ success: true, data: { totalNet: 1 } });

    await svc.execute(byKey.get('payroll.ytd')!, {}, session, user, cfg, ctx);
    expect(caller.call.mock.calls[0][2].year).toBe(new Date().getFullYear());
  });

  it('lets explicit arguments beat derived ones', async () => {
    const { svc, caller } = harness();
    caller.call.mockResolvedValue({ success: true, data: { totalNet: 1 } });

    await svc.execute(byKey.get('payroll.ytd')!, { year: 2025 }, session, user, cfg, ctx);
    expect(caller.call.mock.calls[0][2].year).toBe(2025);
  });
});

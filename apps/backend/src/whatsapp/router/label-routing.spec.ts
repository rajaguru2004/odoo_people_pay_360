import { ActionRegistryService } from './action-registry.service';
import { CommandRouterService } from './command-router.service';
import { essActions } from './actions/ess.actions';
import { approvalActions } from './actions/approval.actions';
import { navActions } from './actions/nav.actions';
import { McpToolDef } from '../../mcp/tool.types';

/**
 * If it is on the menu, typing it must work.
 *
 * People read "My company items" in the list and type it back. Eight of
 * twenty-four labels used to answer "I did not understand that", because a
 * label and a keyword were separate things an author had to remember to keep
 * in sync — and nothing checked that they were.
 *
 * The registry now derives keywords from labels, so this suite is what proves
 * the derivation actually reaches the router. It runs the REAL registry and
 * the REAL router against the REAL catalogue: a fake registry that reads
 * `keywords` directly would pass while the shipped path stayed broken, which
 * is exactly the trap that hid this in the first place.
 */

const CATALOGUE = [...essActions(), ...approvalActions(), ...navActions()];

/**
 * Permissive tool registry — the routing tests are not about tool shape.
 *
 * Cast through `unknown` because the stub deliberately omits `description`: a
 * routing case cares which tool a label reaches, not what the tool says about
 * itself, and filling in prose for every entry would bury that.
 */
const tools: any = {
  getByName: (name: string): McpToolDef =>
    ({
      name,
      kind: name.match(
        /_create$|_cancel$|_approve$|_reject$|check_in$|check_out$|lunch_start$|lunch_end$|_nominate$|_acknowledge$/,
      )
        ? 'write'
        : 'read',
      roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
      inputSchema: {},
      auditResourceType: 'X',
      execute: async () => ({}),
    }) as unknown as McpToolDef,
};

function boot() {
  const registry = new ActionRegistryService(tools);
  registry.onModuleInit();
  const sessions: any = { resolveMenuChoice: () => null, resolveMenuLabel: () => null };
  return { registry, router: new CommandRouterService(registry, sessions) };
}

const session: any = { id: 's1' };
const visible = CATALOGUE.filter((a) => !a.hidden);

describe('menu labels route as typed text', () => {
  const { router } = boot();

  it.each(visible.map((a) => [a.menuLabel, a.key] as const))(
    'typing %p runs %s',
    (label, key) => {
      const r = router.resolve(session, { kind: 'text', text: label, callbackId: null }, false);
      expect(r.type).toBe('action');
      if (r.type === 'action') expect(r.action.key).toBe(key);
    },
  );

  it.each(visible.map((a) => [a.menuLabel, a.key] as const))(
    'typing %p in a different case still runs %s',
    (label, key) => {
      // A phone capitalises the first letter of a sentence on its own.
      const r = router.resolve(
        session,
        { kind: 'text', text: label.toUpperCase(), callbackId: null },
        false,
      );
      expect(r.type).toBe('action');
      if (r.type === 'action') expect(r.action.key).toBe(key);
    },
  );

  it('routes a poll vote, which carries only the option text', () => {
    // Poll mode resolves against the stored menu first, but falls through to
    // the text ladder — which is only safe because labels are keywords.
    for (const action of visible) {
      const r = router.resolve(
        session,
        { kind: 'poll', text: action.menuLabel, callbackId: null },
        false,
      );
      expect(r.type).toBe('action');
    }
  });

  it('does not let a label shadow a control verb', () => {
    // "menu", "help", "cancel", "stop" must keep meaning what they mean, no
    // matter what a future action is called.
    for (const word of ['menu', 'help', 'cancel', 'stop', 'back', 'yes', 'no']) {
      const r = router.resolve(session, { kind: 'text', text: word, callbackId: null }, false);
      expect(r.type).toBe('control');
    }
  });

  it('leaves hidden actions unreachable by name', () => {
    // Approvals come from a token; a section is opened by tapping a row.
    // Neither should be summonable by typing its internal label.
    const { router: r2 } = boot();
    for (const action of CATALOGUE.filter((a) => a.hidden)) {
      const r = r2.resolve(
        session,
        { kind: 'text', text: action.menuLabel, callbackId: null },
        false,
      );
      if (r.type === 'action') expect(r.action.key).not.toBe(action.key);
    }
  });
});

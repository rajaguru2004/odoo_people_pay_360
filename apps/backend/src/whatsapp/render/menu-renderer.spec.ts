import { buildGroupMenu, buildMainMenu } from './menu-renderer';
import { MENU_GROUPS, menuGroup } from '../router/menu-groups';
import { decodeCallback, decodeControl } from '../router/callback-id';
import { WA_LIST } from './wa-limits';
import { WhatsAppActionDef } from '../router/action.types';

/**
 * The menu is the front door of the whole channel, and it has exactly one
 * property that cannot be allowed to drift: tapping the second row and typing
 * "2" must run the same action. Everything else here is presentation.
 */

const OPTS = {
  title: 'HR services',
  description: 'Pick one.',
  buttonText: 'Open menu',
  footerText: 'HR portal',
};

function act(key: string, group: string, order = 1): WhatsAppActionDef {
  return {
    key,
    menuLabel: key.replace(/\./g, ' '),
    menuGroup: group,
    menuOrder: order,
    roles: ['EMPLOYEE'],
    requiresEmployee: true,
    sensitivity: 'normal',
    keywords: [],
    confirmPolicy: 'none',
    tool: { name: 'noop' },
    render: () => ({ plain: '' }),
  } as WhatsAppActionDef;
}

/** Every row that is an action (i.e. not a group-picker row). */
function actionRows(list: any) {
  return (list?.sections ?? []).flatMap((s: any) => s.rows);
}

describe('menu-renderer', () => {
  describe('a catalogue that fits the row budget', () => {
    const actions = [
      act('attendance.checkin', 'attendance', 1),
      act('attendance.checkout', 'attendance', 2),
      act('leave.balance', 'leave', 1),
      act('pay.payslips', 'pay', 1),
    ];

    it('renders one list, sectioned by declared group order', () => {
      const built = buildMainMenu(actions, OPTS);
      expect(built.list).toBeDefined();
      expect(built.list!.sections.map((s) => s.title)).toEqual(['Attendance', 'Leave', 'Pay']);
    });

    it('numbers the rows the same way the text does', () => {
      // THE invariant. Row i and menu[i] must name the same action, or the
      // list and the numbers people type disagree.
      const built = buildMainMenu(actions, OPTS);
      const rows = actionRows(built.list);

      expect(rows).toHaveLength(built.menu.length);
      rows.forEach((row: any, i: number) => {
        expect(decodeCallback(row.rowId)!.actionKey).toBe(built.menu[i].actionKey);
        expect(row.title.startsWith(`${built.menu[i].n}.`)).toBe(true);
      });
    });

    it('enumerates every action in the plain fallback', () => {
      const built = buildMainMenu(actions, OPTS);
      for (const o of built.menu) expect(built.plain).toContain(o.label);
    });

    it('carries no authority in a row id', () => {
      // A row can be tapped from a month-old chat by whoever holds the handset.
      const built = buildMainMenu(actions, OPTS);
      for (const row of actionRows(built.list)) {
        expect(decodeCallback(row.rowId)!.params).toEqual({});
      }
    });
  });

  describe('a catalogue larger than the row budget', () => {
    // The real EMPLOYEE catalogue is ~15 actions; the cap is 10.
    const actions = [
      ...Array.from({ length: 6 }, (_, i) => act(`attendance.a${i}`, 'attendance', i)),
      ...Array.from({ length: 3 }, (_, i) => act(`leave.a${i}`, 'leave', i)),
      act('pay.payslips', 'pay'),
      act('money.loans', 'money'),
      ...Array.from({ length: 3 }, (_, i) => act(`requests.a${i}`, 'requests', i)),
    ];

    it('falls back to a group picker rather than truncating', () => {
      const built = buildMainMenu(actions, OPTS);
      expect(actions.length).toBeGreaterThan(WA_LIST.maxRowsTotal);
      expect(built.list!.sections).toHaveLength(1);

      const rows = actionRows(built.list);
      // One row per non-empty group, plus the "Everything" escape hatch.
      expect(rows).toHaveLength(5 + 1);
      expect(decodeControl(decodeCallback(rows[rows.length - 1].rowId)!.actionKey)).toBe('menu_all');
    });

    it('points every group row at a declared section', () => {
      const built = buildMainMenu(actions, OPTS);
      const rows = actionRows(built.list).slice(0, -1);
      for (const row of rows) {
        const decoded = decodeCallback(row.rowId)!;
        expect(decoded.actionKey).toBe('menu.section');
        expect(menuGroup(decoded.params.g)).toBeDefined();
      }
    });

    it('still lists every action for a numeric reply', () => {
      // The picker changes what is TAPPABLE, never what is reachable: someone
      // who types "12" must still get the twelfth action.
      const built = buildMainMenu(actions, OPTS);
      expect(built.menu).toHaveLength(actions.length);
      expect(built.menu[11].actionKey).toBe(actions[11].key);
    });
  });

  describe('a section', () => {
    const group = MENU_GROUPS.find((g) => g.key === 'leave')!;
    const actions = [act('leave.balance', 'leave', 1), act('leave.apply', 'leave', 2)];

    it('restarts the numbering and keeps rows aligned to it', () => {
      const built = buildGroupMenu(group, actions);
      const rows = actionRows(built.list);

      expect(built.menu.map((o) => o.n)).toEqual([1, 2]);
      rows.forEach((row: any, i: number) => {
        expect(decodeCallback(row.rowId)!.actionKey).toBe(built.menu[i].actionKey);
      });
    });

    it('says so when a section is empty for this caller', () => {
      const built = buildGroupMenu(group, []);
      expect(built.menu).toEqual([]);
      expect(built.list).toBeUndefined();
    });
  });

  it('handles a caller with no visible actions at all', () => {
    const built = buildMainMenu([], OPTS);
    expect(built.list).toBeUndefined();
    expect(built.menu).toEqual([]);
    expect(built.plain).toContain('nothing available');
  });
});

describe('a tapped row echoes once', () => {
  // WhatsApp puts BOTH the row title and its description into the message the
  // user appears to have sent. Carrying the label in both made every selection
  // render twice — "3. Today's attendance" then "Today's attendance" — which
  // reads as the bot repeating itself.
  const actions = [
    act('attendance.checkin', 'attendance', 1),
    act('attendance.today', 'attendance', 2),
    act('leave.balance', 'leave', 1),
  ];

  it('gives action rows no description', () => {
    const built = buildMainMenu(actions, OPTS);
    for (const row of actionRows(built.list)) {
      expect(row.description).toBeUndefined();
    }
  });

  it('keeps a description on the GROUP picker, where it is not a duplicate', () => {
    // There the description previews what is inside the section, which is
    // genuinely extra information rather than the title again.
    const many = Array.from({ length: 14 }, (_, i) =>
      act(`attendance.a${i}`, i < 7 ? 'attendance' : 'leave', i),
    );
    const built = buildMainMenu(many, OPTS);
    const rows = actionRows(built.list);
    expect(rows[0].description).toBeTruthy();
    expect(rows[0].description).not.toBe(rows[0].title);
  });

  it('never truncates a real menu label', () => {
    // The title is now the ONLY place the label appears in a row, so a label
    // that overflows 24 chars would be silently clipped for good.
    const built = buildMainMenu(actions, OPTS);
    for (const row of actionRows(built.list)) {
      expect(row.title).not.toContain('…');
    }
  });
});

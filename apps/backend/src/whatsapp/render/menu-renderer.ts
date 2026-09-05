import { MenuOption } from '../session/whatsapp-session.service';
import { encodeCallback, encodeControl } from '../router/callback-id';
import { MENU_GROUPS, MenuGroupDef, menuGroup } from '../router/menu-groups';
import { WaList, WaListRow, WhatsAppActionDef } from '../router/action.types';
import { WA_LIST, fit } from './wa-limits';
import { bold, italic, lines, renderMenu } from './wa-format';

/**
 * Turns the action catalogue into something tappable.
 *
 * Pure and synchronous: no settings, no Prisma, no config. Everything it needs
 * arrives as an already-filtered list of actions, which is what makes the one
 * invariant that matters testable without a running app —
 *
 *   list row i names the same action as menu[i]
 *
 * — because typing "2" and tapping the second row must be the same act. The
 * session stores `menu` regardless of whether the list rendered, so a user on a
 * client that shows nothing tappable is never worse off than before.
 */

export interface BuiltMenu {
  /** Authoritative numbered text. Always complete, always the fallback. */
  plain: string;
  /** What rememberMenu() stores. Covers EVERY visible action shown. */
  menu: MenuOption[];
  /** Present only when the actions fit the row budget, or as a group picker. */
  list?: WaList;
}

export interface MainMenuOpts {
  title: string;
  description: string;
  buttonText: string;
  footerText?: string;
}

/**
 * One row per action. Kept together so numbering and rowIds cannot diverge.
 *
 * NO description. WhatsApp echoes a tapped row's title AND description into
 * the chat, so carrying the label in both rendered every selection twice —
 *
 *   3. Today's attendance
 *   Today's attendance
 *
 * — which reads as a bug in the bot. The title alone carries the label; the
 * numbered plain-text fallback carries the full wording for anyone whose
 * client shows no list at all.
 */
function rowsFor(options: MenuOption[]): WaListRow[] {
  return options.map((o) => ({
    // The number lives in the title so the list itself teaches the numbering:
    // people type "4" whether or not anything rendered, and now they can see
    // which 4 they mean.
    title: fit(`${o.n}. ${o.label}`, WA_LIST.rowTitle),
    rowId: encodeCallback(o.actionKey, o.params ?? {}),
  }));
}

/** Numbered text, grouped under bold headings. The fallback everyone can read. */
function plainFor(options: MenuOption[], actions: WhatsAppActionDef[], trailer: string): string {
  const byKey = new Map(actions.map((a) => [a.key, a]));
  const blocks: string[] = [];

  for (const g of MENU_GROUPS) {
    const inGroup = options.filter((o) => byKey.get(o.actionKey)?.menuGroup === g.key);
    if (!inGroup.length) continue;
    blocks.push(`${g.emoji ? `${g.emoji} ` : ''}${bold(g.label)}\n${renderMenu(inGroup)}`);
  }

  // Anything whose group is unknown still has to appear — dropping it silently
  // would hide an action the registry believes is visible.
  const ungrouped = options.filter((o) => !menuGroup(byKey.get(o.actionKey)?.menuGroup));
  if (ungrouped.length) blocks.push(renderMenu(ungrouped));

  return lines(...blocks.flatMap((b, i) => (i ? ['', b] : [b])), '', italic(trailer));
}

/**
 * The main menu.
 *
 * Two shapes, chosen by whether the catalogue fits WhatsApp's row budget:
 *
 *  - It fits            -> one list, sections = groups, rows = actions.
 *  - It does not        -> a GROUP PICKER, one row per group, each opening a
 *                          second list via the hidden `menu.section` action.
 *
 * The group picker is not a degraded mode — with a dozen-plus actions it is the
 * better menu anyway. What matters is that `plain` and `menu` still enumerate
 * everything either way, so nothing becomes unreachable because a cap moved.
 */
export function buildMainMenu(
  actions: WhatsAppActionDef[],
  opts: MainMenuOpts,
): BuiltMenu {
  const options: MenuOption[] = actions.map((a, i) => ({
    n: i + 1,
    label: a.menuLabel,
    actionKey: a.key,
  }));

  if (!options.length) {
    return { plain: 'There is nothing available for your account here yet.', menu: [] };
  }

  const plain = plainFor(options, actions, 'Reply with a number, or tap the menu above.');

  if (options.length <= WA_LIST.maxRowsTotal) {
    const sections = MENU_GROUPS.map((g) => ({
      title: fit(g.label, WA_LIST.sectionTitle),
      rows: rowsFor(options.filter((o) => byGroup(actions, o) === g.key)),
    })).filter((s) => s.rows.length);

    const ungrouped = rowsFor(options.filter((o) => !menuGroup(byGroup(actions, o))));
    if (ungrouped.length) sections.push({ title: 'Other', rows: ungrouped });

    return { plain, menu: options, list: { ...listShell(opts), sections } };
  }

  // Group picker. Rows are groups, not actions, so `menu` — which is what a
  // numeric reply resolves against — still lists the ACTIONS. A tap and a
  // number therefore do different-but-both-correct things at this level: the
  // tap opens a section, the number runs the action it is numbered against.
  const groups = MENU_GROUPS.map((g) => ({
    g,
    members: options.filter((o) => byGroup(actions, o) === g.key),
  })).filter((x) => x.members.length);

  const rows: WaListRow[] = groups.map(({ g, members }) => ({
    title: fit(g.label, WA_LIST.rowTitle),
    description: fit(
      members
        .slice(0, 3)
        .map((m) => m.label)
        .join(' · '),
      WA_LIST.rowDescription,
    ),
    rowId: encodeCallback('menu.section', { g: g.key }),
  }));

  rows.push({
    title: 'Everything',
    description: 'The full numbered list',
    rowId: encodeControl('menu_all'),
  });

  return {
    plain,
    menu: options,
    list: {
      ...listShell(opts),
      sections: [{ title: fit('Choose a section', WA_LIST.sectionTitle), rows }],
    },
  };
}

/** One group's actions, as its own list. Numbering restarts here. */
export function buildGroupMenu(
  group: MenuGroupDef,
  actions: WhatsAppActionDef[],
): BuiltMenu {
  const options: MenuOption[] = actions.map((a, i) => ({
    n: i + 1,
    label: a.menuLabel,
    actionKey: a.key,
  }));

  if (!options.length) {
    return {
      plain: lines(bold(group.label), 'Nothing here is available for your account.'),
      menu: [],
    };
  }

  const plain = lines(
    `${group.emoji ? `${group.emoji} ` : ''}${bold(group.label)}`,
    renderMenu(options),
    '',
    italic('Reply with a number, or MENU to go back.'),
  );

  return {
    plain,
    menu: options,
    list: {
      title: fit(group.label, WA_LIST.title),
      description: 'Pick one.',
      buttonText: fit('Open', WA_LIST.buttonText),
      footerText: 'Reply MENU to go back',
      sections: [{ title: fit(group.label, WA_LIST.sectionTitle), rows: rowsFor(options) }],
    },
  };
}

function listShell(opts: MainMenuOpts): Omit<WaList, 'sections'> {
  return {
    title: fit(opts.title, WA_LIST.title),
    description: fit(opts.description, WA_LIST.description),
    buttonText: fit(opts.buttonText, WA_LIST.buttonText),
    footerText: opts.footerText,
  };
}

function byGroup(actions: WhatsAppActionDef[], o: MenuOption): string | undefined {
  return actions.find((a) => a.key === o.actionKey)?.menuGroup;
}

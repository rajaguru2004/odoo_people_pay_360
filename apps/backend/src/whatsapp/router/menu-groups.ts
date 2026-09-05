/**
 * The declared menu sections.
 *
 * `menuGroup` used to be free text sorted with `localeCompare`, which put
 * Approvals first and Money before Pay — an order nobody chose. Declaring the
 * groups makes the order a decision, and gives the list renderer a stable,
 * short key it can safely put inside a callback id.
 *
 * A non-hidden action whose `menuGroup` is not listed here is a startup crash
 * (invariant 11), so a typo surfaces at boot rather than as an item that
 * quietly vanishes from the menu.
 */
export interface MenuGroupDef {
  /** Appears inside callback ids. Keep it short, lowercase and stable. */
  key: string;
  /** Section heading. WhatsApp caps a section title at 24 characters. */
  label: string;
  order: number;
  /** Used in the plain-text rendering only — list section titles stay clean. */
  emoji?: string;
}

export const MENU_GROUPS: readonly MenuGroupDef[] = [
  { key: 'attendance', label: 'Attendance', order: 10, emoji: '🕘' },
  { key: 'leave', label: 'Leave', order: 20, emoji: '🏖️' },
  { key: 'pay', label: 'Pay', order: 30, emoji: '💰' },
  { key: 'money', label: 'Money', order: 40, emoji: '🏦' },
  { key: 'requests', label: 'My requests', order: 50, emoji: '📄' },
  { key: 'company', label: 'Company', order: 60, emoji: '🏢' },
  { key: 'approvals', label: 'Approvals', order: 70, emoji: '📝' },
] as const;

const BY_KEY = new Map(MENU_GROUPS.map((g) => [g.key, g]));

export function menuGroup(key: string | undefined): MenuGroupDef | undefined {
  return key ? BY_KEY.get(key) : undefined;
}

/** Sort weight for an action's group. Unknown groups sort last, not first. */
export function groupOrder(key: string | undefined): number {
  return menuGroup(key)?.order ?? 999;
}

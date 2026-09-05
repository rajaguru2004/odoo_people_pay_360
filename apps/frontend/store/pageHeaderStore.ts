import { create } from 'zustand';

export interface Crumb {
  label: string;
  /** Omit on the last crumb — the current page is not a link to itself. */
  href?: string;
}

export interface PageHeaderEntry {
  /**
   * The route that declared this entry. Load-bearing: TopHeader renders the
   * override only while it still matches the current pathname, so a page that
   * has already unmounted can never paint its title over the next one during a
   * navigation.
   */
  pathname: string;
  title: string;
  subtitle?: string;
  /**
   * Overrides the trail TopHeader would otherwise derive from the nav tree.
   * Worth declaring only where the route cannot describe the page — a record
   * detail whose crumb should name the record, or a screen the nav never links
   * to. Everything else is better left to the derived trail.
   */
  breadcrumbs?: Crumb[];
}

interface PageHeaderState {
  /**
   * What the currently-rendered page wants TopHeader to show, or null when the
   * page declares nothing (TopHeader then falls back to its own static
   * `getPageInfo(pathname)` map).
   */
  entry: PageHeaderEntry | null;
  set: (entry: PageHeaderEntry) => void;
  /**
   * Drops the entry only if `pathname` still owns it. An unmounting page must
   * not wipe the heading the *next* page has already declared, which is what an
   * unguarded clear does whenever the incoming effect runs before the outgoing
   * cleanup.
   */
  clear: (pathname: string) => void;
}

/**
 * The page title/subtitle slot lives in TopHeader, which renders OUTSIDE the
 * routed page subtree — so a page cannot pass it down as props. This store is
 * that channel: a page declares its heading through `usePageHeader`, TopHeader
 * reads it here.
 *
 * Why the page owns the text rather than a map inside TopHeader: pages already
 * hold their own translated `t('title')`/`t('subtitle')` keys, and many titles
 * are per-record ("Monthly salary slip 8/2026") which a static path->string
 * table cannot express at all.
 */
export const usePageHeaderStore = create<PageHeaderState>((set) => ({
  entry: null,
  set: (entry) => set({ entry }),
  clear: (pathname) =>
    set((state) => (state.entry?.pathname === pathname ? { entry: null } : state)),
}));

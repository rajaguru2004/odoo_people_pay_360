import { create } from 'zustand';

export interface Crumb {
  label: string;
  /** Omit on the last crumb — the current page is not a link to itself. */
  href?: string;
}

export interface PageHeaderEntry {
  /**
   * The route that declared this entry. Load-bearing: the shell renders it only
   * while it still matches the current pathname, so a page that has already
   * unmounted can never paint its title over the next one mid-navigation.
   */
  pathname: string;
  title: string;
  subtitle?: string;
  /**
   * Overrides the trail the shell derives from the nav tree. Worth declaring
   * only where the route cannot describe the page — a record whose crumb should
   * carry its name. Everything else is better left derived, because a
   * hand-written crumb is one more place to forget when a route moves.
   */
  breadcrumbs?: Crumb[];
}

interface PageHeaderState {
  /**
   * What the currently-rendered page wants the shell to show, or null when the
   * page declares nothing and the derived nav location should be used instead.
   */
  entry: PageHeaderEntry | null;
  set: (entry: PageHeaderEntry) => void;
  /**
   * Drops the entry only if `pathname` still owns it. An unmounting page must
   * not wipe the heading the NEXT page has already declared, which is what an
   * unguarded clear does whenever the incoming effect runs before the outgoing
   * cleanup — and React runs them in exactly that order.
   */
  clear: (pathname: string) => void;
}

/**
 * The channel between a page and the one heading slot in Topbar.
 *
 * The dashboard renders exactly one `<h1>`, and it lives in Topbar — outside the
 * routed subtree, so a page cannot pass it down as props. A page declares its
 * title through `usePageHeader` instead of painting a second heading of its own;
 * two headings on one screen is the defect this exists to prevent.
 *
 * The page owns the text rather than a lookup table in Topbar because a page
 * already holds its own translated strings, and many titles name a record
 * ("Contract — Aisha Al Balushi") which a path-to-string map cannot express.
 */
export const usePageHeaderStore = create<PageHeaderState>((set) => ({
  entry: null,
  set: (entry) => set({ entry }),
  clear: (pathname) =>
    set((state) => (state.entry?.pathname === pathname ? { entry: null } : state)),
}));

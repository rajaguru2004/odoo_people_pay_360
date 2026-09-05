import { describe, expect, it, beforeEach } from 'vitest';
import { renderWithProviders, screen } from '@/test/render';
import { navigationState } from '@/test/router-mock';
import { usePageHeaderStore } from '@/store/pageHeaderStore';
import PageBreadcrumbs from './PageBreadcrumbs';

/**
 * The trail at the top of the page body.
 *
 * It is DERIVED from the nav tree rather than declared page by page. That is
 * the property under test: ~100 screens get a trail without being edited, and
 * a route that moves in navConfig cannot leave a stale crumb behind. A page may
 * still override, and an override must win.
 *
 * It deliberately does not sit in TopHeader: that bar carries the page title
 * and its description, and a third line does not fit beside them.
 */

/** The trail's labels, in order. */
function crumbs(): string[] {
  const nav = document.querySelector('nav[aria-label="Breadcrumb"]');
  if (!nav) return [];
  return Array.from(nav.querySelectorAll('a, span[aria-current], span'))
    .filter((el) => el.children.length === 0 && el.textContent?.trim())
    .map((el) => el.textContent!.trim());
}

beforeEach(() => {
  usePageHeaderStore.setState({ entry: null });
  navigationState.pathname = '/dashboard';
});

describe('derived breadcrumbs', () => {
  it('shows no trail on the dashboard itself', () => {
    renderWithProviders(<PageBreadcrumbs />, { role: 'ADMIN' });
    expect(crumbs()).toEqual([]);
  });

  it('names the module on the hub itself', () => {
    // The anchor the deeper trails grow from. Dropping it would make the row
    // appear and disappear as the reader moves in and out of the module.
    navigationState.pathname = '/dashboard/people';
    renderWithProviders(<PageBreadcrumbs />, { role: 'ADMIN' });
    expect(crumbs()).toEqual(['People']);
  });

  it('shows no trail on a screen the nav does not list', () => {
    // `/dashboard/profile` sits under no module, so there is nothing to root a
    // trail at and the row is omitted rather than left holding a dead crumb.
    navigationState.pathname = '/dashboard/profile';
    renderWithProviders(<PageBreadcrumbs />, { role: 'ADMIN' });
    expect(crumbs()).toEqual([]);
  });

  it('roots the trail at the module, not at the main dashboard', () => {
    // From inside Payroll the useful way back is the payroll hub. The main
    // dashboard is a step sideways and is already one click away in the rail.
    navigationState.pathname = '/dashboard/payroll/manage';
    renderWithProviders(<PageBreadcrumbs />, { role: 'ADMIN' });

    expect(crumbs()).toEqual(['Payroll', 'Run Payroll']);
  });

  it('links the section crumb at the module hub', () => {
    navigationState.pathname = '/dashboard/payroll/batches';
    renderWithProviders(<PageBreadcrumbs />, { role: 'ADMIN' });

    const link = document.querySelector('nav[aria-label="Breadcrumb"] a[href="/dashboard/payroll/manage"]');
    expect(link).toBeTruthy();
  });

  it('drops the href from a section crumb that points at the current page', () => {
    // Payroll's header points at Run Payroll, the same URL as its first child,
    // so linking the section crumb would hand the reader a way back to where
    // they already are.
    navigationState.pathname = '/dashboard/payroll/manage';
    renderWithProviders(<PageBreadcrumbs />, { role: 'ADMIN' });

    const nav = document.querySelector('nav[aria-label="Breadcrumb"]')!;
    expect(crumbs()).toEqual(['Payroll', 'Run Payroll']);
    expect(nav.querySelector('a[href="/dashboard/payroll/manage"]')).toBeNull();
  });

  it('stays out of the header, which owns the title and its description', () => {
    navigationState.pathname = '/dashboard/payroll/manage';
    const { container } = renderWithProviders(<PageBreadcrumbs />, { role: 'ADMIN' });
    expect(container.querySelector('header')).toBeNull();
  });

  it('appends the page title for a record page the nav does not list', () => {
    // `/dashboard/employees/e-1` resolves to the directory it sits under; the
    // record itself is only nameable by the page's own title.
    navigationState.pathname = '/dashboard/employees/e-1';
    usePageHeaderStore.setState({
      entry: { pathname: '/dashboard/employees/e-1', title: 'Asha Rahman' },
    });
    renderWithProviders(<PageBreadcrumbs />, { role: 'ADMIN' });

    expect(crumbs()).toEqual(['People', 'Employee Directory', 'Asha Rahman']);
  });

  it('follows the role, not the URL', () => {
    // An employee's nav has no People group, so the same path must not claim
    // one. Their own record is reached through My Records.
    navigationState.pathname = '/dashboard/my-documents';
    renderWithProviders(<PageBreadcrumbs />, { role: 'EMPLOYEE' });

    expect(crumbs()).toEqual(['My Records', 'My Documents']);
  });
});

describe('declared breadcrumbs', () => {
  it('lets a page override the derived trail', () => {
    navigationState.pathname = '/dashboard/payroll/manage';
    usePageHeaderStore.setState({
      entry: {
        pathname: '/dashboard/payroll/manage',
        title: 'Run Payroll',
        breadcrumbs: [{ label: 'Custom', href: '/dashboard' }, { label: 'Trail' }],
      },
    });
    renderWithProviders(<PageBreadcrumbs />, { role: 'ADMIN' });

    expect(crumbs()).toEqual(['Custom', 'Trail']);
  });

  it('ignores an entry left behind by the page we just navigated away from', () => {
    // Guarded on pathname: the outgoing page's cleanup can run after the
    // incoming page's effect, and a stale trail is worse than none. The
    // derived trail for the route we are actually on wins.
    navigationState.pathname = '/dashboard/employees';
    usePageHeaderStore.setState({
      entry: {
        pathname: '/dashboard/payroll/manage',
        title: 'Run Payroll',
        breadcrumbs: [{ label: 'Stale' }],
      },
    });
    renderWithProviders(<PageBreadcrumbs />, { role: 'ADMIN' });

    expect(crumbs()).toEqual(['People', 'Employee Directory']);
  });
});

/**
 * The payroll module, whose hub is a SIBLING of the routes it owns.
 *
 * These routes rendered NO trail at all before `basePath`: the group's href is
 * `/dashboard/payroll/manage`, so nothing under `/dashboard/payroll/` that was
 * not an exact nav child resolved to the module. Reported from the screens
 * themselves — "many screens missing it".
 */
describe('payroll — a module hub that sits beside its own routes', () => {
  it('names the module and the run on a payroll run detail', () => {
    navigationState.pathname = '/dashboard/payroll/run-123';
    usePageHeaderStore.setState({
      entry: { pathname: '/dashboard/payroll/run-123', title: 'Monthly salary slip 8/2026' },
    });
    renderWithProviders(<PageBreadcrumbs />, { role: 'ADMIN' });

    expect(crumbs()).toEqual(['Payroll', 'Monthly salary slip 8/2026']);
  });

  it('keeps the section crumb on a batch record', () => {
    // The middle crumb is the whole point: without it the trail would end on
    // "Payroll Batches" and mark the LIST as the page the reader is on.
    navigationState.pathname = '/dashboard/payroll/batches/b-1';
    usePageHeaderStore.setState({
      entry: { pathname: '/dashboard/payroll/batches/b-1', title: 'Engineering' },
    });
    renderWithProviders(<PageBreadcrumbs />, { role: 'ADMIN' });

    expect(crumbs()).toEqual(['Payroll', 'Payroll Batches', 'Engineering']);
  });

  it('routes an employee to the same payslip through their own group', () => {
    navigationState.pathname = '/dashboard/payroll/run-123';
    usePageHeaderStore.setState({
      entry: { pathname: '/dashboard/payroll/run-123', title: 'Monthly salary slip 8/2026' },
    });
    renderWithProviders(<PageBreadcrumbs />, { role: 'EMPLOYEE' });

    expect(crumbs()).toEqual(['My Pay', 'My Payslips', 'Monthly salary slip 8/2026']);
  });
});

/**
 * The property the client actually asked for: ONE trail, and its last crumb is
 * the page you are on.
 */
describe('exactly one trail, ending where the reader is', () => {
  it('renders a single Breadcrumb nav, never two', () => {
    navigationState.pathname = '/dashboard/payroll/manage';
    renderWithProviders(<PageBreadcrumbs />, { role: 'ADMIN' });

    expect(document.querySelectorAll('nav[aria-label="Breadcrumb"]')).toHaveLength(1);
  });

  it('marks only the last crumb as the current page', () => {
    navigationState.pathname = '/dashboard/payroll/run-123';
    usePageHeaderStore.setState({
      entry: { pathname: '/dashboard/payroll/run-123', title: 'Monthly salary slip 8/2026' },
    });
    renderWithProviders(<PageBreadcrumbs />, { role: 'ADMIN' });

    const current = document.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0].textContent?.trim()).toBe('Monthly salary slip 8/2026');
  });

  it('never links the crumb the reader is already standing on', () => {
    // A link to the current page is a dead control, and it makes the trail read
    // as though the destination were somewhere else.
    navigationState.pathname = '/dashboard/payroll/batches';
    renderWithProviders(<PageBreadcrumbs />, { role: 'ADMIN' });

    const nav = document.querySelector('nav[aria-label="Breadcrumb"]')!;
    expect(nav.querySelector('a[href="/dashboard/payroll/batches"]')).toBeNull();
    // …while the crumb above it stays a working way back.
    expect(nav.querySelector('a[href="/dashboard/payroll/manage"]')).toBeTruthy();
  });
});

describe('what it does not render', () => {
  it('paints no heading of its own', () => {
    // The dashboard has exactly one heading slot and it is in TopHeader.
    navigationState.pathname = '/dashboard/payroll/manage';
    const { container } = renderWithProviders(<PageBreadcrumbs />, { role: 'ADMIN' });
    expect(container.querySelector('h1')).toBeNull();
  });

  it('renders nothing at all when there is no trail to show', () => {
    navigationState.pathname = '/dashboard';
    const { container } = renderWithProviders(<PageBreadcrumbs />, { role: 'ADMIN' });
    expect(container.firstChild).toBeNull();
  });
});

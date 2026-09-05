import { describe, expect, it, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { navigationState } from '@/test/router-mock';
import { usePageHeaderStore } from '@/store/pageHeaderStore';
import { usePageHeader } from './usePageHeader';

/**
 * The channel a page uses to reach TopHeader, which renders outside the routed
 * subtree and so cannot be handed props.
 */

beforeEach(() => {
  usePageHeaderStore.setState({ entry: null });
  navigationState.pathname = '/dashboard/payroll';
});

describe('usePageHeader', () => {
  it('declares the title and subtitle for the current route', () => {
    renderHook(() => usePageHeader('Payroll', 'Runs, batches and payslips'));

    expect(usePageHeaderStore.getState().entry).toEqual({
      pathname: '/dashboard/payroll',
      title: 'Payroll',
      subtitle: 'Runs, batches and payslips',
      breadcrumbs: undefined,
    });
  });

  it('carries an optional breadcrumb override', () => {
    renderHook(() => usePageHeader('Asha Rahman', undefined, [{ label: 'People', href: '/dashboard/people' }, { label: 'Asha Rahman' }]));

    expect(usePageHeaderStore.getState().entry?.breadcrumbs).toEqual([
      { label: 'People', href: '/dashboard/people' },
      { label: 'Asha Rahman' },
    ]);
  });

  it('does not loop on a fresh array literal every render', () => {
    // Callers pass array literals. Depending on the reference would mean
    // set() → render → new array → set(), forever.
    const { rerender } = renderHook(() =>
      usePageHeader('Payroll', undefined, [{ label: 'Payroll' }]),
    );
    const first = usePageHeaderStore.getState().entry;

    rerender();

    expect(usePageHeaderStore.getState().entry).toEqual(first);
  });

  it('clears its own entry on unmount', () => {
    const { unmount } = renderHook(() => usePageHeader('Payroll'));
    unmount();
    expect(usePageHeaderStore.getState().entry).toBeNull();
  });

  it('does not wipe the entry the next page has already declared', () => {
    // The incoming page's effect can run before the outgoing page's cleanup;
    // an unguarded clear would blank the heading mid-navigation.
    const { unmount } = renderHook(() => usePageHeader('Payroll'));
    usePageHeaderStore.setState({ entry: { pathname: '/dashboard/people', title: 'People' } });

    unmount();

    expect(usePageHeaderStore.getState().entry?.title).toBe('People');
  });
});

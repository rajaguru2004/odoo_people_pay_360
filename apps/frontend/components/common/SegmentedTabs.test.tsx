import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import SegmentedTabs from './SegmentedTabs';

const TABS = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending', count: 3 },
  { key: 'approved', label: 'Approved' },
] as const;

describe('SegmentedTabs', () => {
  it('is a tablist with exactly one selected tab', () => {
    renderWithProviders(
      <SegmentedTabs tabs={TABS} value="pending" onChange={vi.fn()} testIdPrefix="leave-tab" ariaLabel="Leave status" />,
    );

    expect(screen.getByRole('tablist', { name: 'Leave status' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab', { selected: true }).map((t) => t.textContent)).toEqual([
      'Pending3',
    ]);
  });

  it('reports the tapped key', async () => {
    const onChange = vi.fn();
    const { user } = renderWithProviders(
      <SegmentedTabs tabs={TABS} value="all" onChange={onChange} testIdPrefix="leave-tab" ariaLabel="Leave status" />,
    );

    await user.click(screen.getByTestId('leave-tab-approved'));
    expect(onChange).toHaveBeenCalledWith('approved');
  });

  it('keeps every tab thumb-sized and unsquashed', () => {
    // `h-11` is the 44px floor; `shrink-0 whitespace-nowrap` is what stops four
    // labels compressing into ellipses at 390px — the row scrolls instead.
    renderWithProviders(
      <SegmentedTabs tabs={TABS} value="all" onChange={vi.fn()} testIdPrefix="leave-tab" ariaLabel="Leave status" />,
    );

    for (const tab of screen.getAllByRole('tab')) {
      expect(tab).toHaveClass('h-11', 'shrink-0', 'whitespace-nowrap');
    }
  });

  it('shows a count only where one was given', () => {
    renderWithProviders(
      <SegmentedTabs tabs={TABS} value="all" onChange={vi.fn()} testIdPrefix="leave-tab" ariaLabel="Leave status" />,
    );

    expect(screen.getByTestId('leave-tab-pending')).toHaveTextContent('3');
    expect(screen.getByTestId('leave-tab-all')).toHaveTextContent(/^All$/);
  });

  it('renders a zero count rather than hiding it', () => {
    // `count &&` would drop a legitimate 0 and leave the reader unable to tell
    // "nothing pending" from "we did not count".
    renderWithProviders(
      <SegmentedTabs
        tabs={[{ key: 'pending', label: 'Pending', count: 0 }]}
        value="pending"
        onChange={vi.fn()}
        testIdPrefix="t"
        ariaLabel="Status"
      />,
    );
    expect(screen.getByTestId('t-pending')).toHaveTextContent('0');
  });
});

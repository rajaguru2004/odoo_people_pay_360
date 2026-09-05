import { describe, expect, it } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen } from '@/test/utils';
import AttentionStrip, { type AttentionItem } from './AttentionStrip';

const items: AttentionItem[] = [
  { key: 'a', label: 'Aisha Al Balushi', detail: '12 days left', severity: 'critical' },
  { key: 'b', label: 'Omar Al Harthy', detail: 'expires in a month', severity: 'warning' },
  { key: 'c', label: 'Finance', detail: 'no department head', severity: 'info', href: '/dashboard/departments' },
];

describe('AttentionStrip', () => {
  it('counts what it holds', () => {
    renderWithProviders(<AttentionStrip title="Needs attention" items={items} />);
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('keeps the rows mounted while collapsed', () => {
    // The header count and the DOM must not be able to disagree: unmounting the
    // rows would leave a "3" over an empty list for anyone reading the markup,
    // and lose the anchors a find-in-page relies on.
    renderWithProviders(<AttentionStrip title="Needs attention" items={items} />);

    expect(screen.getByText('Aisha Al Balushi')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /show what needs attention/i })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('opens on a click and says so', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AttentionStrip title="Needs attention" items={items} />);

    await user.click(screen.getByRole('button', { name: /show what needs attention/i }));

    expect(screen.getByRole('button', { name: /hide what needs attention/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('marks each row with the colour of its severity', () => {
    // The left edge is readable before the words are.
    const { container } = renderWithProviders(
      <AttentionStrip title="Needs attention" items={items} />,
    );
    expect(container.querySelector('.bg-status-error')).toBeTruthy();
    expect(container.querySelector('.bg-status-warning')).toBeTruthy();
    expect(container.querySelector('.bg-status-info')).toBeTruthy();
  });

  it('says nothing needs attention rather than offering an empty toggle', () => {
    renderWithProviders(
      <AttentionStrip title="Needs attention" items={[]} emptyLabel="Nothing needs attention." />,
    );

    expect(screen.getByText('Nothing needs attention.')).toBeInTheDocument();
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('offers the escape hatch when the strip is a sample of a longer list', () => {
    renderWithProviders(
      <AttentionStrip
        title="Needs attention"
        items={items}
        seeAll={{ label: 'See all 23', href: '/dashboard/contracts' }}
      />,
    );
    expect(screen.getByRole('link', { name: 'See all 23' })).toHaveAttribute(
      'href',
      '/dashboard/contracts',
    );
  });
});

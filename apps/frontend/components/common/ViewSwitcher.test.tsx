import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { LayoutGrid, List } from 'lucide-react';
import { renderWithProviders, screen } from '@/test/utils';
import { ViewSwitcher } from './ViewSwitcher';

const OPTIONS = [
  { id: 'cards' as const, label: 'Cards', icon: LayoutGrid },
  { id: 'table' as const, label: 'Table', icon: List },
];

/** The switcher is controlled, so keyboard movement needs a real owner of the value. */
function Stateful() {
  const [view, setView] = useState<'cards' | 'table'>('cards');
  return (
    <ViewSwitcher
      options={OPTIONS}
      value={view}
      onChange={setView}
      label="Branch view"
      testIdPrefix="branch-view"
    />
  );
}

function setup(value: 'cards' | 'table' = 'cards') {
  const onChange = vi.fn();
  renderWithProviders(
    <ViewSwitcher
      options={OPTIONS}
      value={value}
      onChange={onChange}
      label="Branch view"
      testIdPrefix="branch-view"
    />,
  );
  return { onChange };
}

describe('ViewSwitcher', () => {
  it('states which view is showing, exclusively', () => {
    setup('cards');

    // Exclusivity is announced once by the group rather than implied by two
    // independent pressed states that happen to disagree.
    expect(screen.getByRole('radiogroup', { name: 'Branch view' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Cards' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Table' })).not.toBeChecked();
  });

  it('reports the view the reader picked', async () => {
    const user = userEvent.setup();
    const { onChange } = setup('cards');

    await user.click(screen.getByRole('radio', { name: 'Table' }));
    expect(onChange).toHaveBeenCalledWith('table');
  });

  it('moves between views with the arrow keys, and wraps at the ends', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Stateful />);

    screen.getByRole('radio', { name: 'Cards' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Table' })).toBeChecked();

    // Past the end and round: two options mean the arrow keys can never dead-end.
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Cards' })).toBeChecked();
  });

  it('keeps only the selected option in the tab order', () => {
    setup('table');

    expect(screen.getByRole('radio', { name: 'Table' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'Cards' })).toHaveAttribute('tabindex', '-1');
  });
});

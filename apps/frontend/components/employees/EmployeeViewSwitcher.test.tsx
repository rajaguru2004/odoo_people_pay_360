import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders, screen } from '@/test/utils';
import EmployeeViewSwitcher, { type EmployeeViewType } from './EmployeeViewSwitcher';

/** Controlled, so keyboard movement needs a real owner of the value. */
function Stateful({ initial = 'table' as EmployeeViewType }) {
  const [view, setView] = useState<EmployeeViewType>(initial);
  return <EmployeeViewSwitcher view={view} onChange={setView} />;
}

describe('EmployeeViewSwitcher', () => {
  it('offers the two views the directory has, and no more', () => {
    renderWithProviders(<EmployeeViewSwitcher view="table" onChange={vi.fn()} />);

    const group = screen.getByRole('radiogroup', { name: 'Employee view' });
    expect(group).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByRole('radio', { name: 'Table' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Cards' })).toBeInTheDocument();
  });

  it('opens on the table, which is the view the directory has always shown', () => {
    renderWithProviders(<EmployeeViewSwitcher view="table" onChange={vi.fn()} />);

    expect(screen.getByRole('radio', { name: 'Table' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Cards' })).not.toBeChecked();
  });

  it('reports the view the reader picked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(<EmployeeViewSwitcher view="table" onChange={onChange} />);

    await user.click(screen.getByRole('radio', { name: 'Cards' }));
    expect(onChange).toHaveBeenCalledWith('cards');
  });

  it('names each view for a screen reader even where the label is hidden', () => {
    // The visible text collapses below `sm`, so an icon is all that is left. A
    // control whose only name is an icon cannot be reached by voice or read
    // aloud, which is the whole reason the aria-label is there.
    renderWithProviders(<EmployeeViewSwitcher view="cards" onChange={vi.fn()} />);

    expect(
      screen.getByRole('radio', { name: 'Cards' }).getAttribute('aria-label'),
    ).toBe('Cards');
  });

  it('moves between the views with the arrow keys', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Stateful />);

    screen.getByRole('radio', { name: 'Table' }).focus();
    await user.keyboard('{ArrowRight}');

    expect(screen.getByRole('radio', { name: 'Cards' })).toBeChecked();
  });
});

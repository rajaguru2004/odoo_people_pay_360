import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders, screen, within } from '@/test/utils';
import EmployeeFilterPanel from './EmployeeFilterPanel';
import { EMPTY_EMPLOYEE_FILTERS, type EmployeeFilters } from './employeeFacts';

const DEPARTMENTS = [
  { id: 'dep-1', code: 'FIN', name: 'Finance' },
  { id: 'dep-2', code: 'ENG', name: 'Engineering' },
];

const BRANCHES = [{ id: 'br-1', code: 'MCT', name: 'Muscat' }];

function setup(filters: Partial<EmployeeFilters> = {}) {
  const onChange = vi.fn();
  const onExport = vi.fn();

  renderWithProviders(
    <EmployeeFilterPanel
      filters={{ ...EMPTY_EMPLOYEE_FILTERS, ...filters }}
      onChange={onChange}
      departments={DEPARTMENTS}
      branches={BRANCHES}
      onExport={onExport}
      exporting={false}
      trailing={<button type="button">View switcher</button>}
    />,
  );

  return { onChange, onExport };
}

describe('EmployeeFilterPanel', () => {
  it('keeps the search box named exactly as the directory has always named it', () => {
    setup();

    // The browser spec selects this control by its accessible name. Renaming it
    // is a silent break: the panel still works and the suite stops finding it.
    expect(screen.getByLabelText('Search employees')).toBeInTheDocument();
  });

  it('reports what was typed without waiting for a submit', async () => {
    const user = userEvent.setup();
    const { onChange } = setup();

    await user.type(screen.getByLabelText('Search employees'), 'A');

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ search: 'A' }),
    );
  });

  it('opens with the three filters showing, not folded away', () => {
    setup();

    // These selects have been on this toolbar since the screen was built.
    // Collapsing them behind the button would take a control away from people
    // who already reach for it.
    expect(screen.getByLabelText('Department')).toBeVisible();
    expect(screen.getByLabelText('Branch')).toBeVisible();
    expect(screen.getByLabelText('Status')).toBeVisible();
  });

  it('offers every department and branch it was given, plus a way back to all', () => {
    setup();

    expect(screen.getByRole('option', { name: 'Every department' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Finance' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Engineering' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Muscat' })).toBeInTheDocument();
  });

  it('names every status the API can return', () => {
    setup();

    for (const label of ['Active', 'On leave', 'Suspended', 'Terminated']) {
      expect(screen.getByRole('option', { name: label })).toBeInTheDocument();
    }
  });

  it('passes a chosen department up as its id, not its name', async () => {
    const user = userEvent.setup();
    const { onChange } = setup();

    await user.selectOptions(screen.getByLabelText('Department'), 'dep-2');

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ departmentId: 'dep-2' }),
    );
  });

  it('can be folded away, and says so', async () => {
    const user = userEvent.setup();
    setup();

    const toggle = screen.getByRole('button', { name: /^filters/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('Department')).not.toBeInTheDocument();
  });

  it('counts only the filters the button hides, never the visible search', () => {
    setup({ search: 'Aisha' });

    // A badge that is already showing a 1 when the screen opens is a badge the
    // reader learns to ignore by their second visit.
    expect(screen.queryByRole('button', { name: /clear/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument();
  });

  it('counts the choices in force and offers to clear them', () => {
    setup({ status: 'ACTIVE', departmentId: 'dep-1' });

    // Read from inside the button rather than through its accessible name: the
    // badge sits adjacent to the label, so the computed name runs the two
    // together and an assertion on it would be testing that concatenation.
    // Anchored, because "Clear 2 filters" sits beside it and also contains the
    // word.
    const toggle = screen.getByRole('button', { name: /^filters/i });
    expect(within(toggle).getByText('2')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /clear 2 filters/i }),
    ).toBeInTheDocument();
  });

  it('clears the selects but leaves the search text alone', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ search: 'Aisha', status: 'ACTIVE' });

    await user.click(screen.getByRole('button', { name: /clear 1 filter/i }));

    // The search box is visible with its text in it. Wiping it from a control
    // labelled for the three selects clears something nobody pointed at.
    expect(onChange).toHaveBeenCalledWith({
      ...EMPTY_EMPLOYEE_FILTERS,
      search: 'Aisha',
    });
  });

  it('offers the export and hands the click straight to the page', async () => {
    const user = userEvent.setup();
    const { onExport } = setup();

    await user.click(screen.getByRole('button', { name: /export/i }));

    expect(onExport).toHaveBeenCalledTimes(1);
  });

  it('makes room on the toolbar for the view switcher', () => {
    setup();

    expect(screen.getByRole('button', { name: 'View switcher' })).toBeInTheDocument();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen, within } from '@/test/utils';
import type { LibraryItem, LibraryTypeValue } from '@/types/library';

const api = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  deactivate: vi.fn(),
  seedDefaults: vi.fn(),
}));

vi.mock('@/services/libraryItemService', () => ({ default: api }));

import { LibrarySection } from './LibrarySection';

function item(overrides: Partial<LibraryItem> & { id: string; label: string }): LibraryItem {
  return {
    libraryType: 'POSITION',
    isActive: true,
    sortOrder: 0,
    defaultDays: null,
    isPaid: true,
    requiresNoticeDays: 0,
    affectsBalance: true,
    genderRestriction: null,
    payBasis: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const ROWS: Record<string, LibraryItem[]> = {
  POSITION: [item({ id: 'p1', label: 'Manager' }), item({ id: 'p2', label: 'Employee' })],
  LEAVE_TYPE: [
    item({
      id: 'l1',
      label: 'Annual Leave',
      libraryType: 'LEAVE_TYPE',
      defaultDays: 30,
      requiresNoticeDays: 7,
    }),
    item({
      id: 'l2',
      label: 'Maternity Leave',
      libraryType: 'LEAVE_TYPE',
      defaultDays: 50,
      genderRestriction: 'FEMALE',
      affectsBalance: false,
    }),
  ],
};

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.list.mockImplementation((type?: LibraryTypeValue) =>
    Promise.resolve({ success: true, data: ROWS[type ?? 'POSITION'] ?? [] }),
  );
  api.create.mockResolvedValue({ success: true, data: ROWS.POSITION[0] });
});

describe('Library editor', () => {
  it('opens on positions and lists what is in that library', async () => {
    renderWithProviders(<LibrarySection />);

    expect(await screen.findByText('Manager')).toBeInTheDocument();
    expect(screen.getByText('Employee')).toBeInTheDocument();
    expect(api.list).toHaveBeenCalledWith('POSITION', undefined);
  });

  it('adds an entry to the library that is open', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LibrarySection />);
    await screen.findByText('Manager');

    await user.type(screen.getByLabelText(/new positions entry/i), 'Site Supervisor');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({ libraryType: 'POSITION', label: 'Site Supervisor' }),
    );
  });

  /**
   * The reason the payload is built per library rather than sent whole: the API
   * refuses `payBasis` anywhere but an employment type, and the leave fields on
   * a job title would be columns nothing reads.
   */
  it('sends the leave metadata only for a leave type', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LibrarySection />);
    await screen.findByText('Manager');

    await user.type(screen.getByLabelText(/new positions entry/i), 'Driver');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    const positionPayload = api.create.mock.calls[0][0];
    expect(positionPayload).not.toHaveProperty('defaultDays');
    expect(positionPayload).not.toHaveProperty('payBasis');

    await user.click(screen.getByRole('button', { name: 'Leave types' }));
    await screen.findByText('Annual Leave');

    await user.type(screen.getByLabelText(/new leave types entry/i), 'Study Leave');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(api.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        libraryType: 'LEAVE_TYPE',
        label: 'Study Leave',
        defaultDays: 0,
        isPaid: true,
        affectsBalance: true,
        genderRestriction: null,
      }),
    );
  });

  it('shows the leave metadata beside each leave type', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LibrarySection />);
    await screen.findByText('Manager');

    await user.click(screen.getByRole('button', { name: 'Leave types' }));

    const maternity = (await screen.findByText('Maternity Leave')).closest('li')!;
    expect(within(maternity).getByText('50 days')).toBeInTheDocument();
    expect(within(maternity).getByText('FEMALE')).toBeInTheDocument();
    expect(within(maternity).getByText('Off balance')).toBeInTheDocument();
  });

  it('flips an entry between active and disabled through the same control', async () => {
    const user = userEvent.setup();
    api.update.mockResolvedValue({ success: true, data: ROWS.POSITION[0] });
    renderWithProviders(<LibrarySection />);
    await screen.findByText('Manager');

    await user.click(screen.getByRole('button', { name: 'Disable Manager' }));

    expect(api.update).toHaveBeenCalledWith('p1', { isActive: false });
  });
});

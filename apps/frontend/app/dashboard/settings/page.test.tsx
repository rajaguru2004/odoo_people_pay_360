import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, screen } from '@/test/utils';
import { useAuthStore } from '@/store/authStore';
import type { UserRole } from '@/types/auth';
import type { PublicBranding } from '@/types/settings';

const BRANDING: PublicBranding = {
  company_name: 'People Pay 360',
  company_short_name: 'PP360',
  primary_color: '#00358F',
  accent_color: '#f66600',
  default_currency: 'OMR',
  default_timezone: 'Asia/Muscat',
};

const ADMIN_SETTINGS: Record<string, string> = {
  ...BRANDING,
  attendance_office_start: '08:00',
  attendance_office_end: '17:00',
  attendance_grace_minutes: '15',
  attendance_weekly_off_days: '5,6',
  attendance_half_day_threshold: '0.5',
  attendance_day_end: '20:00',
  attendance_geofence_default_radius_m: '150',
  contract_expiry_alert_days: '60',
  probation_alert_days: '30',
  visa_expiry_alert_days: '30',
  default_notice_period_days: '30',
  default_annual_leave_days: '30',
};

const settingsCalls = vi.hoisted(() => ({ getAll: vi.fn(), update: vi.fn() }));

vi.mock('@/services/settingsService', () => ({
  default: {
    getPublic: () => Promise.resolve({ success: true, data: BRANDING }),
    getAll: settingsCalls.getAll,
    update: settingsCalls.update,
  },
}));

// The tabs a non-admin never opens still mount their hooks through this module
// tree, so the services they reach for are stubbed rather than left to 404.
vi.mock('@/services/libraryItemService', () => ({
  default: {
    list: () => Promise.resolve({ success: true, data: [] }),
    create: vi.fn(),
    update: vi.fn(),
    deactivate: vi.fn(),
    seedDefaults: vi.fn(),
  },
}));

import SettingsPage from './page';

function signInAs(role: UserRole) {
  useAuthStore.setState({
    user: { id: 'u1', email: `${role.toLowerCase()}@peoplepay360.com`, role, isActive: true },
    isAuthenticated: true,
    isLoading: false,
    hasHydrated: true,
  });
}

beforeEach(() => {
  settingsCalls.getAll.mockReset();
  settingsCalls.getAll.mockResolvedValue({ success: true, data: ADMIN_SETTINGS });
  settingsCalls.update.mockReset();
  settingsCalls.update.mockResolvedValue({ success: true, data: ADMIN_SETTINGS });
});

describe('Settings', () => {
  it('offers an administrator every configurable section', async () => {
    signInAs('ADMIN');
    renderWithProviders(<SettingsPage />);

    const nav = await screen.findByRole('navigation', { name: 'Settings sections' });
    for (const label of [
      'Preferences',
      'Branding',
      'Attendance',
      'People',
      'Overtime policies',
      'Supervisors',
      'Libraries',
    ]) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(nav).toBeInTheDocument();
  });

  /**
   * The decision this screen turns on. The rail offers Settings to every role,
   * but `GET /system-settings` is ADMIN only — so an employee gets the panel
   * that reads the public branding endpoint instead of a route that 403s.
   */
  it('gives an employee the readable panel and no company configuration', async () => {
    signInAs('EMPLOYEE');
    renderWithProviders(<SettingsPage />);

    expect(await screen.findByText('Your account')).toBeInTheDocument();
    expect(screen.getByText('Company profile')).toBeInTheDocument();

    expect(screen.queryByRole('button', { name: 'Branding' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Libraries' })).not.toBeInTheDocument();
    // A single tab is a rail with nothing to choose between, so it is not drawn.
    expect(
      screen.queryByRole('navigation', { name: 'Settings sections' }),
    ).not.toBeInTheDocument();
  });

  it('never asks for the admin-only settings map on behalf of a non-admin', async () => {
    signInAs('EMPLOYEE');
    renderWithProviders(<SettingsPage />);

    await screen.findByText('Your account');
    expect(settingsCalls.getAll).not.toHaveBeenCalled();
  });

  /**
   * An HR manager may assign supervisors and read the overtime policies — both
   * routes accept their role — but every settings-map route refuses them, so
   * those tabs stay out of their rail.
   */
  it('gives HR the two sections its role can actually reach', async () => {
    signInAs('HR_MANAGER');
    renderWithProviders(<SettingsPage />);

    await screen.findByRole('navigation', { name: 'Settings sections' });
    expect(screen.getByRole('button', { name: 'Supervisors' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Overtime policies' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Attendance' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'People' })).not.toBeInTheDocument();
  });

  it('paints no heading of its own — the shell draws one from usePageHeader', async () => {
    signInAs('ADMIN');
    renderWithProviders(<SettingsPage />);

    await screen.findByRole('navigation', { name: 'Settings sections' });
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });
});

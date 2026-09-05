import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import userEvent from '@testing-library/user-event';
import SettingsPage from './page';

/**
 * What the Save button is allowed to put in the payload.
 *
 * Regression cover for a production outage. `POST /system-settings` refuses the
 * WHOLE payload if it carries even one developer-owned key (`mail_*`) while the
 * session is not elevated — so an admin saving Branding got
 * `403 You do not have access to this resource`, and could not change ANY
 * setting on any tab. This screen caused it by resubmitting its entire form
 * state on every Save, `mail_*` included, even though it hides the SMTP card.
 *
 * The second failure is the quieter one and is why the gate is not simply "hide
 * the card". The unelevated GET STRIPS `mail_*`, so local state holds empty
 * strings for them. Had the payload been accepted it would have written those
 * blanks over live SMTP config and silently killed transactional email.
 *
 * The gate deliberately keys off what the SERVER returned rather than the
 * client's `devElevated`: elevation is inferred as `enforced ? hasLiveToken :
 * true`, and `enforced` defaults to false and STAYS false when the dev-mode
 * status probe fails — so a failed probe reads as elevated. The last test pins
 * exactly that case, because it is the one that would put the outage back.
 */

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock('@/services/systemSettingsService', () => ({
  default: {
    getAll: vi.fn(),
    getPublic: vi.fn().mockResolvedValue({ success: true, data: {} }),
    update: vi.fn().mockResolvedValue({ success: true }),
    applyPreset: vi.fn(),
    resetDatabase: vi.fn(),
  },
  CountryPreset: {},
}));

vi.mock('@/services/devModeService', () => ({
  default: {
    status: vi.fn(),
    elevate: vi.fn(),
    revoke: vi.fn(),
  },
}));

// Everything below is a side panel on other tabs; each one fetches on mount and
// none of it participates in the payload under test.
vi.mock('@/services/libraryService', () => ({
  default: { getAll: vi.fn().mockResolvedValue({ success: true, data: [] }), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('@/services/employeeService', () => ({
  default: { update: vi.fn().mockResolvedValue({ success: true }) },
}));
vi.mock('@/services/authService', () => ({
  default: { changePassword: vi.fn() },
}));
vi.mock('@/lib/axios', () => ({
  default: { get: vi.fn().mockResolvedValue({ data: { success: true, data: [] } }), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('@/components/holidays/HolidaysManager', () => ({ default: () => null }));
vi.mock('@/components/settings/CopilotSettingsSection', () => ({ default: () => null }));
vi.mock('@/components/settings/SupervisorHierarchySection', () => ({ default: () => null }));
vi.mock('@/components/settings/OvertimePolicySection', () => ({ default: () => null }));
vi.mock('@/components/dev-mode/DevModeToggle', () => ({ default: () => null }));

import systemSettingsService from '@/services/systemSettingsService';
import devModeService from '@/services/devModeService';
import { useDevModeStore } from '@/store/devModeStore';

const getAll = vi.mocked(systemSettingsService.getAll);
const update = vi.mocked(systemSettingsService.update);
const devStatus = vi.mocked(devModeService.status);

/** The eight developer-owned keys the settings form holds state for. */
const MAIL_KEYS = [
  'mail_enabled', 'mail_host', 'mail_port', 'mail_user',
  'mail_password', 'mail_from', 'mail_from_name', 'mail_bcc',
];

const TENANT_ROWS = [
  { key: 'company_name', value: 'Acme' },
  { key: 'company_subtitle', value: 'Acme HR' },
  { key: 'payroll_currency', value: 'INR' },
];

/** getSettingsList() is a static registry, so a real elevated response carries
 *  every mail_* row — blank when SMTP has never been configured. */
const MAIL_ROWS = [
  { key: 'mail_enabled', value: 'true' },
  { key: 'mail_host', value: 'smtp.acme.test' },
  { key: 'mail_port', value: '587' },
  { key: 'mail_user', value: 'hr@acme.test' },
  { key: 'mail_password', value: 'super-secret' },
  { key: 'mail_from', value: 'noreply@acme.test' },
  { key: 'mail_from_name', value: 'Acme HR' },
  { key: 'mail_bcc', value: '' },
];

function respondWith(rows: { key: string; value: string }[]) {
  getAll.mockResolvedValue({ success: true, data: rows } as any);
}

/**
 * Opens a settings tab, clicks Save, and returns the payload that reached the
 * service. The tab matters: `handleSave` only POSTs settings from the tabs that
 * own them, and the page opens on 'general' (personal preferences), which does
 * not.
 */
async function save(tab = 'system'): Promise<Record<string, string>> {
  await userEvent.click(await screen.findByTestId(`settings-tab-${tab}`));
  const button = await screen.findByRole('button', { name: /save/i });
  await userEvent.click(button);
  await waitFor(() => expect(update).toHaveBeenCalled());
  return update.mock.calls[0][0] as Record<string, string>;
}

describe('Settings page — developer-key write gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDevModeStore.setState({
      devToken: null, expiresAt: null, available: false, enforced: false, checked: false,
    });
    devStatus.mockResolvedValue({ data: { available: true, enforced: true } } as any);
  });

  it('omits every mail_* key when the server withheld them', async () => {
    respondWith(TENANT_ROWS);
    renderWithProviders(<SettingsPage />, { role: 'ADMIN' });
    await waitFor(() => expect(getAll).toHaveBeenCalled());

    const payload = await save();

    for (const key of MAIL_KEYS) expect(payload).not.toHaveProperty(key);
  });

  it('still saves the tenant settings the admin actually came to change', async () => {
    respondWith(TENANT_ROWS);
    renderWithProviders(<SettingsPage />, { role: 'ADMIN' });
    await waitFor(() => expect(getAll).toHaveBeenCalled());

    const payload = await save();

    // The point of the fix: the unrelated save goes through rather than 403ing.
    expect(payload.company_name).toBe('Acme');
    expect(Object.keys(payload).length).toBeGreaterThan(20);
  });

  it('writes mail_* back unchanged when the server did return them', async () => {
    respondWith([...TENANT_ROWS, ...MAIL_ROWS]);
    useDevModeStore.setState({ devToken: 't', expiresAt: Date.now() + 600_000 });
    renderWithProviders(<SettingsPage />, { role: 'ADMIN' });
    await waitFor(() => expect(getAll).toHaveBeenCalled());

    const payload = await save();

    expect(payload.mail_host).toBe('smtp.acme.test');
    expect(payload.mail_password).toBe('super-secret');
    expect(payload.mail_enabled).toBe('true');
  });

  it('does not blank live SMTP config when the dev-mode probe fails', async () => {
    // The probe failing leaves `enforced: false`, which makes `devElevated`
    // read TRUE for an admin. A gate built on that flag would send the eight
    // blanks here and put the 403 — and the config wipe — straight back.
    respondWith(TENANT_ROWS);
    devStatus.mockRejectedValue(new Error('network'));
    renderWithProviders(<SettingsPage />, { role: 'ADMIN' });
    await waitFor(() => expect(getAll).toHaveBeenCalled());

    const payload = await save();

    for (const key of MAIL_KEYS) expect(payload).not.toHaveProperty(key);
  });
});

/**
 * The developer-only tabs.
 *
 * Hidden outright rather than greyed out, so an admin cannot tell they exist.
 * The backend refuses the matching routes with a flat 403, which is the actual
 * boundary — but a tab the server would refuse must never be offered either.
 */
describe('Settings page — developer-only tabs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    respondWith(TENANT_ROWS);
    devStatus.mockResolvedValue({ data: { available: true, enforced: true } } as any);
    useDevModeStore.setState({
      devToken: 't',
      expiresAt: Date.now() + 600_000,
      available: true,
      enforced: true,
      checked: true,
    });
  });

  it('offers HR Copilot to an admin who has unlocked developer mode', async () => {
    renderWithProviders(<SettingsPage />, { role: 'ADMIN' });
    await waitFor(() => expect(getAll).toHaveBeenCalled());

    expect(await screen.findByTestId('settings-tab-copilot')).toHaveTextContent('HR Copilot');
  });

  it('offers no footer save bar — the panel saves through its own controls', async () => {
    // `copilot` is in SELF_SAVING_TABS. Without that the footer renders and
    // handleSave does nothing except report success.
    renderWithProviders(<SettingsPage />, { role: 'ADMIN' });
    await waitFor(() => expect(getAll).toHaveBeenCalled());

    await userEvent.click(await screen.findByTestId('settings-tab-copilot'));

    expect(screen.queryByRole('button', { name: /^save changes$/i })).toBeNull();
  });

  it('hides the tab entirely from an admin who has not unlocked developer mode', async () => {
    useDevModeStore.setState({ devToken: null, expiresAt: null, enforced: true, available: true, checked: true });
    renderWithProviders(<SettingsPage />, { role: 'ADMIN' });
    await waitFor(() => expect(getAll).toHaveBeenCalled());

    expect(screen.queryByTestId('settings-tab-copilot')).toBeNull();
  });
});

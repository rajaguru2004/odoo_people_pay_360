import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor, userEvent } from '@/test/render';
import WhatsAppSettingsSection from './WhatsAppSettingsSection';
import { WhatsAppSettings } from '@/types/whatsapp';

/**
 * The admin half of the WhatsApp channel, pinned against a real 19-day outage.
 *
 * On 2026-08-12 an admin saved the test recipient as `917603941558` — an Indian
 * number with no `+` — while the default country was `SG`. It could not be
 * parsed, so the backend set `redirectMisconfigured` and stopped ALL sending
 * rather than falling back to messaging real employees. That part is correct
 * and deliberate. What was not correct is what the admin could then do about it:
 *
 *  - the API reported the PARSED value, which is `''`, so this page rendered an
 *    EMPTY test-recipient box;
 *  - the red banner said "fix or clear it under Setup", pointing at a field that
 *    already looked clear;
 *  - so there was nothing on screen to correct, and the channel stayed dark
 *    while the admin's own test messages kept working (they take a different
 *    gate), which made it look like a delivery problem rather than a setting.
 *
 * Every case below is one of the links in that chain.
 */

const getSettings = vi.fn();
const updateSettings = vi.fn();
const templates = vi.fn();
const identityStats = vi.fn();
const connectionState = vi.fn();
const outbox = vi.fn();
const actions = vi.fn();
const enrollFromEmployees = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();

vi.mock('@/services/whatsappService', () => ({
  default: {
    getSettings: (...a: unknown[]) => getSettings(...a),
    updateSettings: (...a: unknown[]) => updateSettings(...a),
    templates: (...a: unknown[]) => templates(...a),
    identityStats: (...a: unknown[]) => identityStats(...a),
    connectionState: (...a: unknown[]) => connectionState(...a),
    outbox: (...a: unknown[]) => outbox(...a),
    actions: (...a: unknown[]) => actions(...a),
    enrollFromEmployees: (...a: unknown[]) => enrollFromEmployees(...a),
    setActionsDisabled: vi.fn(),
    verifyPending: vi.fn(),
    retry: vi.fn(),
    drain: vi.fn(),
    qr: vi.fn(),
    testSend: vi.fn(),
    webhookConfig: vi.fn(),
    registerWebhook: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: {
    error: (...a: unknown[]) => toastError(...a),
    success: (...a: unknown[]) => toastSuccess(...a),
  },
}));

/** A configured, switched-on channel — the shape production actually had. */
const CFG: WhatsAppSettings = {
  enabled: true,
  baseUrl: 'https://whatsapp.example.com',
  instanceName: 'Taneka_prod',
  apiKeyConfigured: true,
  apiKeyMasked: '••••2345',
  apiKeySource: 'db',
  adminNumber: '',
  defaultRegion: 'SG',
  appBaseUrl: 'https://hrm.example.com',
  publicApiUrl: 'https://api.example.com',
  minGapMs: 1200,
  maxPerMinute: 20,
  timeoutMs: 15000,
  maxAttempts: 5,
  requireOptIn: true,
  requireVerified: true,
  allowGenericFallback: true,
  disabledTemplates: [],
  interactiveMode: 'auto',
  redirectAllTo: '',
  redirectMisconfigured: false,
  redirectAllToRaw: '',
  autoEnroll: true,
  carbonCopyEnabled: false,
  carbonCopyTo: '',
  carbonCopyMisconfigured: false,
  carbonCopyToRaw: '',
  dryRun: false,
  retentionDays: 90,
  staleHours: 24,
  drainBatchSize: 50,
  inboundEnabled: false,
  enrollmentEnabled: true,
  mutationsEnabled: true,
  approvalsEnabled: false,
  aiFallbackEnabled: false,
  requirePinForSensitive: true,
  actionDenylist: [],
  webhookSecretConfigured: true,
  sessionIdleMinutes: 30,
  flowTtlMinutes: 15,
  pendingActionTtlMinutes: 10,
  approvalTokenTtlMinutes: 2880,
  pinTtlMinutes: 10,
  logMessageBodies: true,
  inboundRetentionDays: 90,
  ratePerPhone5Min: 120,
  ratePerUserHour: 600,
  rateMutations10Min: 100,
  attendanceVerification: 'OFF',
  attendanceFaceOverride: false,
  selfieDailyCap: 4,
  selfieChallengeSeconds: 120,
  verificationLinkTtlMinutes: 10,
  supportContact: '',
  quietHoursStart: '',
  quietHoursEnd: '',
  quietHoursOverrideTemplates: ['approval_requested', 'expiry_reminder'],
};

/** Exactly what production held: unparseable, so the parsed value is ''. */
const BROKEN: WhatsAppSettings = {
  ...CFG,
  redirectAllTo: '',
  redirectMisconfigured: true,
  redirectAllToRaw: '917603941558',
};

beforeEach(() => {
  vi.clearAllMocks();
  getSettings.mockResolvedValue({ data: CFG });
  updateSettings.mockImplementation(async (dto: any) => ({ data: { ...CFG, ...dto } }));
  templates.mockResolvedValue({ data: [] });
  identityStats.mockResolvedValue({
    data: { total: 1, optedIn: 1, verified: 0, deliverable: 0, suspended: 0 },
  });
  connectionState.mockResolvedValue({ data: { configured: true, state: 'open' } });
  outbox.mockResolvedValue({ data: { rows: [], total: 0 } });
  actions.mockResolvedValue({ data: [] });
  enrollFromEmployees.mockResolvedValue({
    data: { committed: false, optedIn: false, considered: 0, results: [] },
  });
});

/**
 * By placeholder rather than by label: `Field` renders the caption as a sibling
 * of the control, so there is no label association to query through.
 */
const testRecipient = () =>
  screen.findByPlaceholderText(/messages go to your team/i) as Promise<HTMLInputElement>;

/** The field lives inside the collapsed "Setup" panel. */
const openSetup = async () =>
  userEvent.click(await screen.findByRole('button', { name: /^Setup/ }));

describe('WhatsAppSettingsSection — the halted-sending state', () => {
  it('shows the stored number that is halting sending', async () => {
    // THE regression. The box rendered empty, so there was nothing to correct.
    getSettings.mockResolvedValue({ data: BROKEN });
    renderWithProviders(<WhatsAppSettingsSection />);

    const box = (await testRecipient()) as HTMLInputElement;
    expect(box.value).toBe('917603941558');
  });

  it('names the number and the country in the banner', async () => {
    getSettings.mockResolvedValue({ data: BROKEN });
    renderWithProviders(<WhatsAppSettingsSection />);

    expect(await screen.findByText(/sending is stopped/i)).toBeInTheDocument();
    expect(await screen.findByText(/917603941558/)).toBeInTheDocument();
    expect(await screen.findByText(/SG/)).toBeInTheDocument();
  });

  it('clears it in one click, without saving the rest of the form', async () => {
    // The channel is down; an unrelated invalid field elsewhere on this page
    // must not stand between the admin and turning it back on.
    getSettings.mockResolvedValue({ data: BROKEN });
    renderWithProviders(<WhatsAppSettingsSection />);

    await userEvent.click(await screen.findByRole('button', { name: /clear it and resume/i }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ redirectAllTo: '' }));
  });

  it('drops the banner once it is cleared', async () => {
    getSettings.mockResolvedValue({ data: BROKEN });
    updateSettings.mockResolvedValue({ data: CFG });
    renderWithProviders(<WhatsAppSettingsSection />);

    await userEvent.click(await screen.findByRole('button', { name: /clear it and resume/i }));

    await waitFor(() =>
      expect(screen.queryByText(/sending is stopped/i)).not.toBeInTheDocument(),
    );
  });

  it('does not call the halted state "test mode"', async () => {
    // Two different situations: test mode is delivering somewhere on purpose,
    // this one is delivering nowhere. Showing both banners would be a lie.
    getSettings.mockResolvedValue({ data: BROKEN });
    renderWithProviders(<WhatsAppSettingsSection />);

    await screen.findByText(/sending is stopped/i);
    expect(screen.queryByText(/test mode is on/i)).not.toBeInTheDocument();
  });

  it('saving the page sends the corrected number through', async () => {
    getSettings.mockResolvedValue({ data: BROKEN });
    renderWithProviders(<WhatsAppSettingsSection />);

    const box = await testRecipient();
    await userEvent.clear(box);
    await userEvent.type(box, '+917603941558');
    await userEvent.click(screen.getAllByRole('button', { name: /^save$/i })[0]);

    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    expect(updateSettings.mock.calls[0][0].redirectAllTo).toBe('+917603941558');
  });

  it('surfaces the server’s refusal when the number is still unreadable', async () => {
    // `lib/axios.ts` rejects with a FLAT object, so reading
    // `err.response.data.message` here would show "Could not save" instead of
    // the one sentence that explains what to do.
    updateSettings.mockRejectedValue({
      success: false,
      statusCode: 400,
      message: '“917603941558” is not a valid phone number for SG.',
    });
    renderWithProviders(<WhatsAppSettingsSection />);

    await openSetup();
    await userEvent.click(screen.getAllByRole('button', { name: /^save$/i })[0]);

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('“917603941558” is not a valid phone number for SG.'),
    );
  });
});

describe('WhatsAppSettingsSection — carbon copy', () => {
  const COPYING = {
    ...CFG,
    carbonCopyEnabled: true,
    carbonCopyTo: '+917603941558',
    carbonCopyToRaw: '+917603941558',
  };

  it('shows the watcher number when copying is on', async () => {
    getSettings.mockResolvedValue({ data: COPYING });
    renderWithProviders(<WhatsAppSettingsSection />);
    await openSetup();

    const box = (await screen.findByPlaceholderText(/no copies are sent/i)) as HTMLInputElement;
    expect(box.value).toBe('+917603941558');
  });

  it('hides the number field when copying is off', async () => {
    renderWithProviders(<WhatsAppSettingsSection />);
    await openSetup();

    await screen.findByText(/send a copy to one number/i);
    expect(screen.queryByPlaceholderText(/no copies are sent/i)).not.toBeInTheDocument();
  });

  it('saves the switch and the number', async () => {
    getSettings.mockResolvedValue({ data: COPYING });
    renderWithProviders(<WhatsAppSettingsSection />);
    await openSetup();
    await userEvent.click(screen.getAllByRole('button', { name: /^save$/i })[0]);

    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    expect(updateSettings.mock.calls[0][0].carbonCopyEnabled).toBe(true);
    expect(updateSettings.mock.calls[0][0].carbonCopyTo).toBe('+917603941558');
  });

  it('shows an unreadable copy number and says employees are unaffected', async () => {
    // Same failure shape as the test recipient, but it must NOT read as an
    // outage — a bad watcher number costs a copy, not a delivery.
    getSettings.mockResolvedValue({
      data: {
        ...COPYING,
        carbonCopyTo: '',
        carbonCopyMisconfigured: true,
        carbonCopyToRaw: '917603941558',
      },
    });
    renderWithProviders(<WhatsAppSettingsSection />);
    await openSetup();

    expect(await screen.findByText(/your team is unaffected/i)).toBeInTheDocument();
    expect(screen.queryByText(/sending is stopped/i)).not.toBeInTheDocument();
    const box = (await screen.findByPlaceholderText(/no copies are sent/i)) as HTMLInputElement;
    expect(box.value).toBe('917603941558');
  });
});

describe('WhatsAppSettingsSection — adding the team’s numbers', () => {
  const PREVIEW = {
    committed: false,
    optedIn: false,
    considered: 3,
    results: [
      {
        employeeId: 'e1',
        employeeCode: 'E001',
        name: 'Aisha Al-Balushi',
        phoneMasked: '+968•••0000',
        outcome: 'linked' as const,
        verified: true,
      },
      {
        employeeId: 'e2',
        employeeCode: 'E002',
        name: 'Ravi Kumar',
        phoneMasked: '+919•••2836',
        outcome: 'linked' as const,
        verified: true,
      },
      {
        employeeId: 'e3',
        employeeCode: 'E003',
        name: 'Sam Tan',
        phoneMasked: '12345',
        outcome: 'skipped' as const,
        verified: false,
        reason: '“12345” is not a valid number for SG. Fix it on their profile.',
      },
    ],
  };

  it('says numbers are added automatically when auto-enrolment is on', async () => {
    // The state production was in: channel green, nobody enrolled, no reason given.
    renderWithProviders(<WhatsAppSettingsSection />);
    expect(await screen.findByText(/added automatically the first time/i)).toBeInTheDocument();
  });

  it('points at the switch when auto-enrolment is off', async () => {
    getSettings.mockResolvedValue({ data: { ...CFG, autoEnroll: false } });
    renderWithProviders(<WhatsAppSettingsSection />);

    expect(
      await screen.findByText(/switch on “Message everyone who has a phone number on file”/i),
    ).toBeInTheDocument();
  });

  it('saves the auto-enrolment switch', async () => {
    renderWithProviders(<WhatsAppSettingsSection />);
    await userEvent.click(
      await screen.findByRole('switch', { name: /message everyone who has a phone number/i }),
    );
    await userEvent.click(screen.getAllByRole('button', { name: /^save$/i })[0]);

    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    expect(updateSettings.mock.calls[0][0].autoEnroll).toBe(false);
  });

  it('previews without writing anything', async () => {
    enrollFromEmployees.mockResolvedValue({ data: PREVIEW });
    renderWithProviders(<WhatsAppSettingsSection />);

    await userEvent.click(await screen.findByRole('button', { name: /add my team’s numbers/i }));

    await waitFor(() =>
      expect(enrollFromEmployees).toHaveBeenCalledWith({ commit: false }),
    );
    expect(await screen.findByText(/2 of 3 can be added, 1 need attention/i)).toBeInTheDocument();
  });

  it('names each person and why one was skipped', async () => {
    enrollFromEmployees.mockResolvedValue({ data: PREVIEW });
    renderWithProviders(<WhatsAppSettingsSection />);
    await userEvent.click(await screen.findByRole('button', { name: /add my team’s numbers/i }));

    expect(await screen.findByText('Aisha Al-Balushi')).toBeInTheDocument();
    expect(await screen.findByText(/is not a valid number for SG/)).toBeInTheDocument();
  });

  it('links without asserting consent unless the box is ticked', async () => {
    enrollFromEmployees.mockResolvedValue({ data: PREVIEW });
    renderWithProviders(<WhatsAppSettingsSection />);
    await userEvent.click(await screen.findByRole('button', { name: /add my team’s numbers/i }));
    await userEvent.click(await screen.findByRole('button', { name: /add 2 numbers/i }));

    await waitFor(() =>
      expect(enrollFromEmployees).toHaveBeenLastCalledWith({
        commit: true,
        confirmConsent: false,
      }),
    );
  });

  it('records employer-asserted consent only when the box is ticked', async () => {
    enrollFromEmployees.mockResolvedValue({ data: PREVIEW });
    renderWithProviders(<WhatsAppSettingsSection />);
    await userEvent.click(await screen.findByRole('button', { name: /add my team’s numbers/i }));
    await userEvent.click(await screen.findByRole('checkbox'));
    await userEvent.click(await screen.findByRole('button', { name: /add 2 numbers/i }));

    await waitFor(() =>
      expect(enrollFromEmployees).toHaveBeenLastCalledWith({
        commit: true,
        confirmConsent: true,
      }),
    );
  });

  it('surfaces the server’s refusal', async () => {
    enrollFromEmployees.mockRejectedValue({
      success: false,
      statusCode: 400,
      message: 'Developer mode is off.',
    });
    renderWithProviders(<WhatsAppSettingsSection />);
    await userEvent.click(await screen.findByRole('button', { name: /add my team’s numbers/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Developer mode is off.'));
  });
});

describe('WhatsAppSettingsSection — the healthy states', () => {
  it('leaves the box empty when no test recipient is set', async () => {
    renderWithProviders(<WhatsAppSettingsSection />);
    await openSetup();
    expect((await testRecipient()).value).toBe('');
    expect(screen.queryByText(/sending is stopped/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/test mode is on/i)).not.toBeInTheDocument();
  });

  it('warns that staff receive nothing while a VALID test recipient is set', async () => {
    getSettings.mockResolvedValue({
      data: { ...CFG, redirectAllTo: '+917603941558', redirectAllToRaw: '+917603941558' },
    });
    renderWithProviders(<WhatsAppSettingsSection />);

    expect(await screen.findByText(/test mode is on/i)).toBeInTheDocument();
    expect(screen.queryByText(/sending is stopped/i)).not.toBeInTheDocument();
  });
});

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor, userEvent } from '@/test/render';
import TelegramSettingsSection from './TelegramSettingsSection';

/**
 * The admin half of the Telegram channel.
 *
 * The cases here are the ones where being wrong is expensive:
 *
 *  1. **An empty token box must never be sent.** The token is write-only, so
 *     there is nothing to pre-fill; sending `''` would be a value, and the
 *     backend cannot tell "leave it alone" from "clear it". Saving a chat id
 *     would silently wipe the bot token.
 *  2. **The token must never be rendered back.** The read projection has no
 *     such field, and this asserts the screen does not invent one.
 *  3. **Refusals are read through `apiErrorMessage`.** This app's axios
 *     interceptor rejects with a FLAT object, so `err.response.data.message` is
 *     always `undefined` — the bug that surfaced a precise backend refusal as
 *     "The operation could not be completed".
 */

const getSettings = vi.fn();
const updateSettings = vi.fn();
const diagnostics = vi.fn();
const testMessage = vi.fn();
const registerWebhook = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();

vi.mock('@/services/telegramService', () => ({
  default: {
    getSettings: (...a: unknown[]) => getSettings(...a),
    updateSettings: (...a: unknown[]) => updateSettings(...a),
    diagnostics: (...a: unknown[]) => diagnostics(...a),
    testMessage: (...a: unknown[]) => testMessage(...a),
    registerWebhook: (...a: unknown[]) => registerWebhook(...a),
  },
}));

vi.mock('sonner', () => ({
  toast: {
    error: (...a: unknown[]) => toastError(...a),
    success: (...a: unknown[]) => toastSuccess(...a),
  },
}));

const CFG = {
  enabled: true,
  botTokenConfigured: true,
  botTokenMasked: '8931…BWn4',
  botTokenSource: 'db' as const,
  inboundEnabled: true,
  webhookSecretConfigured: true,
  linkingEnabled: true,
  notificationsEnabled: true,
  alertChatId: '-5544539023',
  loginAlertsEnabled: true,
  loginAlertFailures: true,
  loginAlertGeo: true,
  geoLookupUrl: 'http://ip-api.com/json/{ip}',
  loginAlertRoles: [] as string[],
  loginAlertFailureMaxPerHour: 10,
  redirectAllTo: '',
  retentionDays: 90,
  maxAttempts: 5,
};

beforeEach(() => {
  vi.clearAllMocks();
  getSettings.mockResolvedValue({ data: CFG });
  updateSettings.mockImplementation(async (dto: any) => ({ data: { ...CFG, ...dto } }));
});

describe('TelegramSettingsSection', () => {
  it('shows the bot token as configured without ever rendering it', async () => {
    renderWithProviders(<TelegramSettingsSection />);
    expect(await screen.findByText(/8931…BWn4/)).toBeInTheDocument();

    const box = screen.getByLabelText(/bot token/i) as HTMLInputElement;
    expect(box.value).toBe('');
    expect(box.type).toBe('password');
  });

  it('lets the chat id be edited and saved', async () => {
    renderWithProviders(<TelegramSettingsSection />);
    const chat = await screen.findByLabelText(/alert group chat id/i);

    await userEvent.clear(chat);
    await userEvent.type(chat, '-100987654321');
    await userEvent.click(screen.getAllByRole('button', { name: /^save$/i })[0]);

    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    expect(updateSettings.mock.calls[0][0].alertChatId).toBe('-100987654321');
  });

  it('does not send the token when the box was left empty', async () => {
    // Saving anything else must not wipe a stored token.
    renderWithProviders(<TelegramSettingsSection />);
    await screen.findByLabelText(/alert group chat id/i);
    await userEvent.click(screen.getAllByRole('button', { name: /^save$/i })[0]);

    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    expect(updateSettings.mock.calls[0][0]).not.toHaveProperty('botToken');
  });

  it('sends the token when one is typed, then clears the box', async () => {
    renderWithProviders(<TelegramSettingsSection />);
    const box = await screen.findByLabelText(/bot token/i);

    await userEvent.type(box, '123456789:NEW-TOKEN');
    await userEvent.click(screen.getAllByRole('button', { name: /^save$/i })[0]);

    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    expect(updateSettings.mock.calls[0][0].botToken).toBe('123456789:NEW-TOKEN');
    await waitFor(() => expect((box as HTMLInputElement).value).toBe(''));
  });

  it('clears the stored token on an explicit Remove', async () => {
    renderWithProviders(<TelegramSettingsSection />);
    await userEvent.click(await screen.findByRole('button', { name: /remove/i }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ clearBotToken: true }));
  });

  it('surfaces the server’s own refusal when saving fails', async () => {
    updateSettings.mockRejectedValue({
      success: false,
      statusCode: 400,
      message: 'Telegram only accepts an HTTPS webhook URL.',
    });
    renderWithProviders(<TelegramSettingsSection />);
    await screen.findByLabelText(/alert group chat id/i);
    await userEvent.click(screen.getAllByRole('button', { name: /^save$/i })[0]);

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('Telegram only accepts an HTTPS webhook URL.'),
    );
  });

  it('reports the bot identity after a check', async () => {
    diagnostics.mockResolvedValue({
      data: {
        bot: { id: '1', username: 'FusionHRMSBot' },
        webhook: null,
        chat: { chatId: '-5544539023', ok: true, title: 'FusionHRMS Login Alerts', type: 'group' },
      },
    });
    renderWithProviders(<TelegramSettingsSection />);
    await userEvent.click(await screen.findByRole('button', { name: /check bot & chat/i }));

    expect(await screen.findByText(/Connected as @FusionHRMSBot/)).toBeInTheDocument();
  });

  it('names the group the stored chat id resolves to', async () => {
    // The confirmation half: a correct id is only recognisable by its title.
    diagnostics.mockResolvedValue({
      data: {
        bot: { id: '1', username: 'FusionHRMSBot' },
        webhook: null,
        chat: { chatId: '-5544539023', ok: true, title: 'FusionHRMS Login Alerts', type: 'group' },
      },
    });
    renderWithProviders(<TelegramSettingsSection />);
    await userEvent.click(await screen.findByRole('button', { name: /check bot & chat/i }));

    expect(await screen.findByText(/FusionHRMS Login Alerts/)).toBeInTheDocument();
    expect(await screen.findByText('-5544539023')).toBeInTheDocument();
  });

  it('shows the stored id and what to do when the chat is not found', async () => {
    // The production failure: the bot was fine and the chat was the broken half,
    // and nothing on screen said which.
    diagnostics.mockResolvedValue({
      data: {
        bot: { id: '1', username: 'FusionHRMSBot' },
        webhook: null,
        chat: { chatId: '-999', ok: false, error: 'Bad Request: chat not found' },
      },
    });
    renderWithProviders(<TelegramSettingsSection />);
    await userEvent.click(await screen.findByRole('button', { name: /check bot & chat/i }));

    expect(await screen.findByText('-999')).toBeInTheDocument();
    expect(await screen.findByText(/Add @FusionHRMSBot to that group/)).toBeInTheDocument();
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Bad Request: chat not found'));
  });

  it('flags a group whose id has changed under it', async () => {
    diagnostics.mockResolvedValue({
      data: {
        bot: { id: '1', username: 'FusionHRMSBot' },
        webhook: null,
        chat: {
          chatId: '-5544539023',
          ok: true,
          title: 'Alerts',
          type: 'supergroup',
          resolvedId: '-1005544539023',
        },
      },
    });
    renderWithProviders(<TelegramSettingsSection />);
    await userEvent.click(await screen.findByRole('button', { name: /check bot & chat/i }));

    expect(await screen.findByText(/-1005544539023/)).toBeInTheDocument();
  });

  it('says so when Telegram rejects the token', async () => {
    diagnostics.mockResolvedValue({ data: { bot: null, webhook: null, chat: null } });
    renderWithProviders(<TelegramSettingsSection />);
    await userEvent.click(await screen.findByRole('button', { name: /check bot & chat/i }));

    expect(await screen.findByText(/did not recognise that token/i)).toBeInTheDocument();
  });

  it('reports where a test message actually went', async () => {
    testMessage.mockResolvedValue({ data: { sent: true, chatId: '-5544539023', messageId: '7' } });
    renderWithProviders(<TelegramSettingsSection />);
    await userEvent.click(await screen.findByRole('button', { name: /send test message/i }));

    await waitFor(() => expect(testMessage).toHaveBeenCalled());
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining('-5544539023'));
  });

  it('surfaces a failed test send instead of claiming it was queued', async () => {
    // The defect this closes: the button reported success while the send failed
    // minutes later in the drainer, with nothing on screen.
    testMessage.mockRejectedValue({
      success: false,
      statusCode: 400,
      message:
        'Telegram refused to post to -999: Bad Request: chat not found. Either that id is not a chat…',
    });
    renderWithProviders(<TelegramSettingsSection />);
    await userEvent.click(await screen.findByRole('button', { name: /send test message/i }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        expect.stringContaining('chat not found'),
        expect.anything(),
      ),
    );
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('disables the test button when there is no chat to send to', async () => {
    getSettings.mockResolvedValue({ data: { ...CFG, alertChatId: '' } });
    renderWithProviders(<TelegramSettingsSection />);
    const btn = await screen.findByRole('button', { name: /send test message/i });
    expect(btn).toBeDisabled();
  });

  it('warns when no chat id is set, because nothing would be posted', async () => {
    getSettings.mockResolvedValue({ data: { ...CFG, alertChatId: '' } });
    renderWithProviders(<TelegramSettingsSection />);
    expect(await screen.findByText(/No group chat ID is set above/i)).toBeInTheDocument();
  });

  it('warns when the token is resolving from the tracked env file', async () => {
    getSettings.mockResolvedValue({ data: { ...CFG, botTokenSource: 'env' } });
    renderWithProviders(<TelegramSettingsSection />);
    expect(await screen.findByText(/tracked in version\s+control/i)).toBeInTheDocument();
  });

  it('warns while the test-mode redirect is swallowing every message', async () => {
    getSettings.mockResolvedValue({ data: { ...CFG, redirectAllTo: '999' } });
    renderWithProviders(<TelegramSettingsSection />);
    await userEvent.click(await screen.findByRole('button', { name: /advanced/i }));
    expect(await screen.findByText(/Staff are not receiving anything/i)).toBeInTheDocument();
  });

  it('round-trips the role allowlist through CSV', async () => {
    getSettings.mockResolvedValue({ data: { ...CFG, loginAlertRoles: ['ADMIN', 'HR_MANAGER'] } });
    renderWithProviders(<TelegramSettingsSection />);
    const roles = (await screen.findByLabelText(/only alert for these roles/i)) as HTMLInputElement;
    expect(roles.value).toBe('ADMIN,HR_MANAGER');

    await userEvent.click(screen.getAllByRole('button', { name: /^save$/i })[0]);
    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    expect(updateSettings.mock.calls[0][0].loginAlertRoles).toBe('ADMIN,HR_MANAGER');
  });

  it('degrades to a message rather than a broken panel when settings will not load', async () => {
    getSettings.mockRejectedValue(new Error('403'));
    renderWithProviders(<TelegramSettingsSection />);
    expect(await screen.findByText(/unavailable on this deployment/i)).toBeInTheDocument();
  });
});

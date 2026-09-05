import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor, userEvent } from '@/test/render';
import TelegramLinkSection from './TelegramLinkSection';

/**
 * The employee-facing half of the Telegram channel.
 *
 * Three behaviours are decided entirely inside this component, so they are
 * asserted here rather than in a browser journey (which would need a real bot
 * and a real Telegram account to complete the round trip):
 *
 *  1. **It renders nothing when the channel is unavailable.** Offering a link
 *     button that the backend then refuses reads as a broken feature rather
 *     than a switched-off one.
 *  2. **The chat id is read-only.** An id that can be typed is an id anyone can
 *     claim, and the prize is somebody else's HR notifications.
 *  3. **A refusal is read through `apiErrorMessage`.** This app's axios
 *     interceptor rejects with a FLAT object, so `err.response.data.message` is
 *     always `undefined` — the bug that once surfaced a precise backend refusal
 *     to the user as "The operation could not be completed".
 */

const me = vi.fn();
const startLink = vi.fn();
const unlink = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();

vi.mock('@/services/telegramService', () => ({
  default: {
    me: (...args: unknown[]) => me(...args),
    startLink: (...args: unknown[]) => startLink(...args),
    unlink: (...args: unknown[]) => unlink(...args),
  },
}));

vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
  },
}));

const UNLINKED = {
  linked: false,
  telegramChatId: null,
  username: null,
  status: null,
  linkedAt: null,
  optedIn: false,
  available: true,
};

const LINKED = {
  linked: true,
  telegramChatId: '111222333',
  username: 'asha',
  status: 'ACTIVE',
  linkedAt: '2026-08-29T10:00:00.000Z',
  optedIn: true,
  available: true,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TelegramLinkSection', () => {
  it('renders nothing when the channel is unavailable', async () => {
    me.mockResolvedValue({ data: { ...UNLINKED, available: false } });
    const { container } = renderWithProviders(<TelegramLinkSection />);
    await waitFor(() => expect(me).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).not.toContain('Telegram'));
  });

  it('renders nothing when the status call fails', async () => {
    // A backend without the channel mounted must not leave a broken card behind.
    me.mockRejectedValue(new Error('404'));
    const { container } = renderWithProviders(<TelegramLinkSection />);
    await waitFor(() => expect(me).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).not.toContain('Get link code'));
  });

  it('offers a link code when the channel is on and nothing is linked', async () => {
    me.mockResolvedValue({ data: UNLINKED });
    renderWithProviders(<TelegramLinkSection />);
    expect(await screen.findByRole('button', { name: /get link code/i })).toBeInTheDocument();
  });

  it('shows the exact command to send after issuing a code', async () => {
    me.mockResolvedValue({ data: UNLINKED });
    startLink.mockResolvedValue({ data: { code: '482913', expiresInMinutes: 15 } });

    renderWithProviders(<TelegramLinkSection />);
    await userEvent.click(await screen.findByRole('button', { name: /get link code/i }));

    expect(await screen.findByText(/\/link 482913/)).toBeInTheDocument();
    expect(screen.getByText(/expires in 15:00/i)).toBeInTheDocument();
  });

  it('surfaces the server’s own refusal, read through apiErrorMessage', async () => {
    me.mockResolvedValue({ data: UNLINKED });
    // The FLAT shape this app's axios interceptor actually rejects with.
    startLink.mockRejectedValue({
      success: false,
      statusCode: 403,
      message: 'Telegram linking is not enabled.',
    });

    renderWithProviders(<TelegramLinkSection />);
    await userEvent.click(await screen.findByRole('button', { name: /get link code/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Telegram linking is not enabled.'));
    // Not the generic fallback — that is the bug being guarded.
    expect(toastError).not.toHaveBeenCalledWith('Could not create a link code');
  });

  it('shows the linked account with a read-only chat id', async () => {
    me.mockResolvedValue({ data: LINKED });
    renderWithProviders(<TelegramLinkSection />);

    expect(await screen.findByText('@asha')).toBeInTheDocument();
    const field = screen.getByDisplayValue('111222333') as HTMLInputElement;
    expect(field.readOnly).toBe(true);
  });

  it('unlinks and re-reads the status', async () => {
    me.mockResolvedValueOnce({ data: LINKED }).mockResolvedValueOnce({ data: UNLINKED });
    unlink.mockResolvedValue({ data: { ok: true } });

    renderWithProviders(<TelegramLinkSection />);
    await userEvent.click(await screen.findByRole('button', { name: /unlink telegram/i }));

    await waitFor(() => expect(unlink).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: /get link code/i })).toBeInTheDocument();
  });

  it('mentions a previous link that was revoked', async () => {
    me.mockResolvedValue({ data: { ...UNLINKED, status: 'REVOKED' } });
    renderWithProviders(<TelegramLinkSection />);
    expect(await screen.findByText(/previous link was removed/i)).toBeInTheDocument();
  });
});

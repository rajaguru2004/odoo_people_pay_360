import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import {
  MyTelegramStatus,
  TelegramDiagnostics,
  TelegramLinkCode,
  TelegramSettings,
  UpdateTelegramSettings,
} from '@/types/telegram';

class TelegramService {
  // ------------------------------------------------------------------ admin
  getSettings(): Promise<ApiResponse<TelegramSettings>> {
    return axiosInstance.get('/telegram/settings');
  }

  updateSettings(dto: UpdateTelegramSettings): Promise<ApiResponse<TelegramSettings>> {
    return axiosInstance.put('/telegram/settings', dto);
  }

  /**
   * Ask Telegram who the bot is and whether the webhook is delivering.
   *
   * Two hops out to api.telegram.org, so it carries its own timeout rather than
   * inheriting the default — the same reason `whatsappService.webhookConfig()`
   * does.
   */
  diagnostics(): Promise<ApiResponse<TelegramDiagnostics>> {
    return axiosInstance.get('/telegram/diagnostics', { timeout: 20_000 });
  }

  registerWebhook(): Promise<ApiResponse<{ url: string }>> {
    return axiosInstance.post('/telegram/webhook/register', {}, { timeout: 20_000 });
  }

  unregisterWebhook(): Promise<ApiResponse<{ removed: boolean }>> {
    return axiosInstance.post('/telegram/webhook/unregister', {}, { timeout: 20_000 });
  }

  /**
   * Send a message to the configured alert chat, to prove the wiring.
   *
   * Rejects with Telegram's own refusal when it fails — the endpoint sends
   * synchronously rather than queuing, so a failure is visible on the button
   * that caused it instead of appearing in a log minutes later.
   */
  testMessage(): Promise<ApiResponse<{ sent: boolean; chatId: string; messageId: string | null }>> {
    return axiosInstance.post('/telegram/test-message', {}, { timeout: 20_000 });
  }

  drain(): Promise<ApiResponse<{ processed: number; sent: number; failed: number }>> {
    return axiosInstance.post('/telegram/outbox/drain', {}, { timeout: 30_000 });
  }

  // ----------------------------------------------------------- self-service
  me(): Promise<ApiResponse<MyTelegramStatus>> {
    return axiosInstance.get('/telegram/me');
  }

  /**
   * Issue a one-time code to send as `/link <code>` to the bot.
   *
   * The code is shown in the browser and redeemed from Telegram — the same
   * direction as Discord, and the same property: neither side alone completes
   * the link. Telegram adds a second reason for that direction: a bot cannot
   * message a chat that has never messaged it, so redemption is also what makes
   * delivery possible at all.
   */
  startLink(): Promise<ApiResponse<TelegramLinkCode>> {
    return axiosInstance.post('/telegram/me/link/start');
  }

  unlink(): Promise<ApiResponse<{ ok: true }>> {
    return axiosInstance.post('/telegram/me/unlink');
  }

  // ------------------------------------------------------------------ admin
  identityStats(): Promise<ApiResponse<{ total: number; active: number; pending: number }>> {
    return axiosInstance.get('/telegram/identities/stats');
  }
}

export default new TelegramService();

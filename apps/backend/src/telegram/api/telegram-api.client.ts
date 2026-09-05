import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosError, AxiosRequestConfig } from 'axios';
import { TelegramResolvedConfig } from '../telegram.types';

const TELEGRAM_API = 'https://api.telegram.org';

export interface TelegramSendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
  retryable: boolean;
  status?: number;
  /** Seconds Telegram asked us to wait, from `parameters.retry_after` on a 429. */
  retryAfterSeconds?: number;
}

/**
 * The only place that speaks HTTP to Telegram.
 *
 * Same adapter contract as EvolutionClient and DiscordApiClient: takes the
 * resolved config, never reads settings itself, never retries (that belongs to
 * the outbox), and never throws on a transport failure — a Telegram outage must
 * not propagate into the business transaction that triggered a notification.
 *
 * The token is a path segment, not a header, which is why nothing here logs a
 * URL: `/bot<token>/sendMessage` would put the secret straight into the logs.
 */
@Injectable()
export class TelegramApiClient {
  private readonly logger = new Logger(TelegramApiClient.name);

  async sendMessage(
    cfg: TelegramResolvedConfig,
    chatId: string,
    html: string,
  ): Promise<TelegramSendResult> {
    const res = await this.request<{ message_id: number }>(cfg, 'sendMessage', {
      chat_id: chatId,
      text: html.slice(0, 4096),
      parse_mode: 'HTML',
      // ESS messages carry portal links; the preview cards add noise without
      // information, exactly as on Discord.
      link_preview_options: { is_disabled: true },
    });
    return res.ok
      ? { ok: true, messageId: String(res.data.message_id), retryable: false }
      : {
          ok: false,
          error: res.error,
          retryable: res.retryable,
          status: res.status,
          retryAfterSeconds: res.retryAfterSeconds,
        };
  }

  async getMe(
    cfg: TelegramResolvedConfig,
  ): Promise<{ id: string; username: string } | null> {
    const res = await this.request<{ id: number; username?: string }>(cfg, 'getMe', {});
    return res.ok ? { id: String(res.data.id), username: res.data.username ?? '' } : null;
  }

  /**
   * Point Telegram at our webhook and pin the secret it must echo back.
   *
   * `drop_pending_updates` is deliberately NOT set: a redeploy should not
   * silently discard link codes people already sent.
   */
  async setWebhook(
    cfg: TelegramResolvedConfig,
    url: string,
    secret: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const res = await this.request<boolean>(cfg, 'setWebhook', {
      url,
      secret_token: secret,
      allowed_updates: ['message'],
    });
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  }

  async deleteWebhook(cfg: TelegramResolvedConfig): Promise<{ ok: boolean; error?: string }> {
    const res = await this.request<boolean>(cfg, 'deleteWebhook', {});
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  }

  /**
   * Resolve a chat id to the chat it names.
   *
   * The whole reason this exists: `sendMessage` answers a bad chat id with
   * `Bad Request: chat not found`, which is the SAME message for four different
   * causes — the id is mistyped, the id belongs to a group this bot was never
   * added to, the bot was removed, or the group was upgraded to a supergroup
   * and its id changed. Reading the chat back turns that into a title an admin
   * can recognise, or a refusal they can act on, BEFORE any alert depends on it.
   */
  async getChat(
    cfg: TelegramResolvedConfig,
    chatId: string,
  ): Promise<
    | { ok: true; id: string; title: string; type: string }
    | { ok: false; error: string }
  > {
    const res = await this.request<{ id: number; title?: string; username?: string; type: string }>(
      cfg,
      'getChat',
      { chat_id: chatId },
    );
    if (!res.ok) return { ok: false, error: res.error };
    return {
      ok: true,
      id: String(res.data.id),
      // A private chat has no title; fall back to the @username so the admin
      // still sees something they can recognise.
      title: res.data.title || (res.data.username ? `@${res.data.username}` : ''),
      type: res.data.type,
    };
  }

  /** Diagnostics for the admin screen: is Telegram actually calling us? */
  async getWebhookInfo(cfg: TelegramResolvedConfig): Promise<Record<string, unknown> | null> {
    const res = await this.request<Record<string, unknown>>(cfg, 'getWebhookInfo', {});
    return res.ok ? res.data : null;
  }

  // ----------------------------------------------------------------- internal

  private async request<T>(
    cfg: TelegramResolvedConfig,
    method: string,
    body: unknown,
  ): Promise<
    | { ok: true; data: T }
    | { ok: false; error: string; retryable: boolean; status?: number; retryAfterSeconds?: number }
  > {
    const conf: AxiosRequestConfig = {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15_000,
    };
    try {
      const { data } = await axios.post<{ ok: boolean; result: T; description?: string }>(
        `${TELEGRAM_API}/bot${cfg.botToken}/${method}`,
        body,
        conf,
      );
      // Telegram answers 200 with ok:false for some errors, so the HTTP status
      // alone is not the success signal.
      if (!data?.ok) {
        return {
          ok: false,
          error: (data?.description || 'Telegram rejected the request').slice(0, 300),
          retryable: false,
        };
      }
      return { ok: true, data: data.result };
    } catch (e) {
      const c = this.classifyError(e);
      return {
        ok: false,
        error: c.message,
        retryable: c.retryable,
        status: c.status,
        retryAfterSeconds: c.retryAfterSeconds,
      };
    }
  }

  /**
   * 429 is Telegram's flood limit and always worth retrying — and unlike
   * Discord it tells us exactly how long to wait, in `parameters.retry_after`.
   * 5xx too. Other 4xx mean the request is wrong (revoked token, chat not
   * found, the user never pressed Start) and a retry only burns attempts.
   */
  classifyError(e: unknown): {
    retryable: boolean;
    message: string;
    status?: number;
    retryAfterSeconds?: number;
  } {
    const err = e as AxiosError<any>;
    const status = err?.response?.status;
    const d = err?.response?.data;
    const message = (d?.description || d?.error || err?.message || 'Unknown error')
      .toString()
      .slice(0, 300);
    const retryAfterSeconds = Number(d?.parameters?.retry_after) || undefined;

    if (status === undefined) {
      const codeName = (err as any)?.code;
      const transient = ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET', 'EAI_AGAIN'];
      return { retryable: transient.includes(codeName) || !codeName, message };
    }
    if (status === 429 || status >= 500) {
      return { retryable: true, message, status, retryAfterSeconds };
    }
    return { retryable: false, message, status };
  }
}

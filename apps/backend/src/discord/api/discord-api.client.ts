import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosError, AxiosRequestConfig } from 'axios';
import { DiscordResolvedConfig } from '../discord.types';

const DISCORD_API = 'https://discord.com/api/v10';

export interface DiscordSendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
  retryable: boolean;
  status?: number;
}

/**
 * The only place that speaks HTTP to Discord.
 *
 * Same adapter contract as EvolutionClient: takes the resolved config, never
 * reads settings itself, never retries (that belongs to the outbox), and never
 * throws on a transport failure — a Discord outage must not propagate into the
 * business transaction that triggered a notification.
 */
@Injectable()
export class DiscordApiClient {
  private readonly logger = new Logger(DiscordApiClient.name);

  /** Open (or reuse) a DM channel with a user. */
  async createDm(cfg: DiscordResolvedConfig, discordUserId: string): Promise<string | null> {
    const res = await this.request<{ id: string }>(cfg, 'POST', '/users/@me/channels', {
      recipient_id: discordUserId,
    });
    return res.ok ? res.data.id : null;
  }

  async postMessage(
    cfg: DiscordResolvedConfig,
    channelId: string,
    content: string,
  ): Promise<DiscordSendResult> {
    const res = await this.request<{ id: string }>(cfg, 'POST', `/channels/${channelId}/messages`, {
      content: content.slice(0, 2000),
      // Suppress link previews; ESS messages carry portal links and the
      // embeds add noise without information.
      flags: 4,
    });
    return res.ok
      ? { ok: true, messageId: res.data.id, retryable: false }
      : { ok: false, error: res.error, retryable: res.retryable, status: res.status };
  }

  /** DM a user, opening the channel if we do not have one cached. */
  async dmUser(
    cfg: DiscordResolvedConfig,
    discordUserId: string,
    content: string,
    cachedChannelId?: string | null,
  ): Promise<DiscordSendResult & { channelId?: string }> {
    let channelId = cachedChannelId ?? null;
    if (!channelId) {
      channelId = await this.createDm(cfg, discordUserId);
      if (!channelId) {
        return {
          ok: false,
          // Almost always "the user does not share a server with the bot, or has
          // DMs closed" — not something a retry fixes.
          error: 'Could not open a DM channel with that user.',
          retryable: false,
        };
      }
    }
    const res = await this.postMessage(cfg, channelId, content);
    return { ...res, channelId };
  }

  /**
   * Replace the application's global slash commands.
   *
   * PUT is a full overwrite, which is what we want: the command set is derived
   * from the action catalogue, so the catalogue is the single source of truth
   * and stale commands cannot linger.
   */
  async registerGlobalCommands(
    cfg: DiscordResolvedConfig,
    commands: unknown[],
  ): Promise<{ ok: boolean; count?: number; error?: string }> {
    const res = await this.request<unknown[]>(
      cfg,
      'PUT',
      `/applications/${cfg.applicationId}/commands`,
      commands,
    );
    return res.ok ? { ok: true, count: res.data.length } : { ok: false, error: res.error };
  }

  async getBotUser(cfg: DiscordResolvedConfig): Promise<{ id: string; username: string } | null> {
    const res = await this.request<{ id: string; username: string }>(cfg, 'GET', '/users/@me');
    return res.ok ? res.data : null;
  }

  // ----------------------------------------------------------------- internal

  private async request<T>(
    cfg: DiscordResolvedConfig,
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
  ): Promise<{ ok: true; data: T } | { ok: false; error: string; retryable: boolean; status?: number }> {
    const conf: AxiosRequestConfig = {
      headers: {
        Authorization: `Bot ${cfg.botToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 15_000,
    };
    try {
      const { data } =
        method === 'GET'
          ? await axios.get<T>(`${DISCORD_API}${path}`, conf)
          : method === 'PUT'
            ? await axios.put<T>(`${DISCORD_API}${path}`, body, conf)
            : await axios.post<T>(`${DISCORD_API}${path}`, body, conf);
      return { ok: true, data };
    } catch (e) {
      const { retryable, message, status } = this.classifyError(e);
      return { ok: false, error: message, retryable, status };
    }
  }

  /**
   * 429 is Discord's rate limit and always worth retrying; 5xx too. Other 4xx
   * mean the request is wrong (bad token, unknown user, DMs closed) and a retry
   * only burns attempts.
   */
  classifyError(e: unknown): { retryable: boolean; message: string; status?: number } {
    const err = e as AxiosError<any>;
    const status = err?.response?.status;
    const d = err?.response?.data;
    const message = (d?.message || d?.error || err?.message || 'Unknown error').toString().slice(0, 300);

    if (status === undefined) {
      const code = (err as any)?.code;
      const transient = ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET', 'EAI_AGAIN'];
      return { retryable: transient.includes(code) || !code, message };
    }
    if (status === 429 || status >= 500) return { retryable: true, message, status };
    return { retryable: false, message, status };
  }
}

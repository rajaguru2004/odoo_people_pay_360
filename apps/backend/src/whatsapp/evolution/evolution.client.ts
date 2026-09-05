import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosError, AxiosRequestConfig } from 'axios';
import {
  ConnectionStateResult,
  QrResult,
  SendResult,
  WhatsAppResolvedConfig,
} from '../whatsapp.types';
import {
  EvolutionBase64Response,
  EvolutionButton,
  EvolutionConnectResponse,
  EvolutionConnectionStateResponse,
  EvolutionGetBase64Body,
  EvolutionNumberCheck,
  EvolutionSendButtonsBody,
  EvolutionSendCarouselBody,
  EvolutionSendListBody,
  EvolutionSendMediaBody,
  EvolutionSendPollBody,
  EvolutionSendResponse,
  EvolutionSendTextBody,
  buttonFamily,
} from './evolution.types';
import { toEvolutionNumber } from '../utils/phone.util';
import { WA_BUTTONS, WA_ID_MAX, WA_LIST, WA_MEDIA_MAX_BYTES, fit } from '../render/wa-limits';

/**
 * The only place that speaks HTTP to Evolution.
 *
 * A pure adapter: every method takes the resolved config rather than reading
 * settings itself, which keeps it trivially unit-testable and stops config
 * resolution leaking into transport code.
 *
 * Two deliberate design choices:
 *
 *  1. It never retries. Retry lives in the durable outbox. This is the opposite
 *     of FusionAnalyticsProvider (which retries in-process) and the difference
 *     matters: a sync pull can be replayed freely, but retrying a *send* after an
 *     ambiguous timeout can double-message a human. The client classifies and
 *     returns; the outbox decides.
 *
 *  2. It never throws on transport failure — it returns `{ ok, retryable, error }`.
 *     A WhatsApp failure must never propagate into the business transaction that
 *     triggered the notification.
 */
@Injectable()
export class EvolutionClient {
  private readonly logger = new Logger(EvolutionClient.name);

  /** Serialises every outbound send in this process (anti-ban pacing). */
  private chain: Promise<unknown> = Promise.resolve();
  private lastSentAt = 0;
  /** Timestamps of sends inside the trailing minute, for the per-minute cap. */
  private recentSends: number[] = [];

  // --------------------------------------------------------------- messaging

  /**
   * POST /message/sendText/{instance}
   * Body is v2 flat: { number, text, delay?, linkPreview? } — no options wrapper.
   */
  async sendText(
    cfg: WhatsAppResolvedConfig,
    args: { toE164: string; text: string; delay?: number; linkPreview?: boolean },
  ): Promise<SendResult> {
    const body: EvolutionSendTextBody = {
      number: toEvolutionNumber(args.toE164),
      text: args.text,
      ...(args.delay !== undefined ? { delay: args.delay } : {}),
      linkPreview: args.linkPreview ?? false,
    };
    return this.throttled(() =>
      this.post<EvolutionSendResponse>(cfg, `/message/sendText/${cfg.instanceName}`, body).then(
        (res) => this.toSendResult(res),
      ),
    );
  }

  /** POST /message/sendMedia/{instance}. Wired for Phase 2; unused in Phase 1. */
  async sendMedia(
    cfg: WhatsAppResolvedConfig,
    args: {
      toE164: string;
      mediatype: 'image' | 'video' | 'document';
      mimetype: string;
      media: string;
      fileName: string;
      caption?: string;
      delay?: number;
    },
  ): Promise<SendResult> {
    const body: EvolutionSendMediaBody = {
      number: toEvolutionNumber(args.toE164),
      mediatype: args.mediatype,
      mimetype: args.mimetype,
      media: args.media,
      fileName: args.fileName,
      ...(args.caption ? { caption: args.caption } : {}),
      ...(args.delay !== undefined ? { delay: args.delay } : {}),
    };
    return this.throttled(() =>
      this.post<EvolutionSendResponse>(cfg, `/message/sendMedia/${cfg.instanceName}`, body).then(
        (res) => this.toSendResult(res),
      ),
    );
  }

  /**
   * POST /message/sendList/{instance} — a tappable sectioned menu.
   *
   * Baileys-backed interactive messages do not render on every WhatsApp client,
   * so callers must be able to fall back. This returns the failure rather than
   * throwing, and MessageComposerService retries as plain text.
   *
   * Two shaping rules live here rather than in the caller. `footerText` is
   * mandatory on the wire (a missing one is a 400), so an absent one is filled
   * with a single space rather than omitted. And the row budget is spent FLAT
   * across sections in order: WhatsApp caps total rows, not rows-per-section,
   * so truncating per section would silently drop the last group entirely while
   * leaving room unused in the first.
   */
  async sendList(
    cfg: WhatsAppResolvedConfig,
    args: {
      toE164: string;
      title: string;
      description: string;
      buttonText: string;
      footerText?: string;
      sections: EvolutionSendListBody['sections'];
    },
  ): Promise<SendResult> {
    const body: EvolutionSendListBody = {
      number: toEvolutionNumber(args.toE164),
      title: fit(args.title, WA_LIST.title),
      description: fit(args.description, WA_LIST.description),
      buttonText: fit(args.buttonText, WA_LIST.buttonText),
      // A space, not '': the field is required and an empty string reads as absent.
      footerText: fit(args.footerText || ' ', WA_LIST.footerText) || ' ',
      sections: this.capSections(args.sections),
    };
    return this.throttled(() =>
      this.post<EvolutionSendResponse>(cfg, `/message/sendList/${cfg.instanceName}`, body).then(
        (res) => this.toSendResult(res),
      ),
    );
  }

  /** Flat row budget across sections, plus per-field truncation. */
  private capSections(
    sections: EvolutionSendListBody['sections'],
  ): EvolutionSendListBody['sections'] {
    const out: EvolutionSendListBody['sections'] = [];
    let budget = WA_LIST.maxRowsTotal;

    for (const section of sections ?? []) {
      if (budget <= 0 || out.length >= WA_LIST.maxSections) break;
      const rows = (section.rows ?? [])
        .slice(0, Math.min(budget, WA_LIST.maxRowsPerSection))
        .map((r) => ({
          title: fit(r.title, WA_LIST.rowTitle),
          ...(r.description ? { description: fit(r.description, WA_LIST.rowDescription) } : {}),
          rowId: String(r.rowId).slice(0, WA_ID_MAX),
        }));
      if (!rows.length) continue; // an empty section renders as a stray heading
      budget -= rows.length;
      out.push({ title: fit(section.title, WA_LIST.sectionTitle), rows });
    }

    const dropped = countRows(sections) - countRows(out);
    if (dropped > 0) {
      this.logger.debug(`sendList: dropped ${dropped} row(s) over the ${WA_LIST.maxRowsTotal} cap`);
    }
    return out;
  }

  /**
   * POST /message/sendPoll/{instance} — a native, tappable single-choice list.
   *
   * Unlike buttons and lists, a poll is a core WhatsApp feature rather than a
   * Business-API one, so it renders on every client including personal accounts
   * driven through Baileys. The trade-off is that a vote carries only the option
   * TEXT, so the caller must be able to map that back to an action.
   */
  async sendPoll(
    cfg: WhatsAppResolvedConfig,
    args: { toE164: string; name: string; options: string[] },
  ): Promise<SendResult> {
    const body: EvolutionSendPollBody = {
      number: toEvolutionNumber(args.toE164),
      name: args.name.slice(0, 255),
      selectableCount: 1,
      // WhatsApp caps a poll at 12 options and each option at ~100 chars.
      values: args.options.slice(0, 12).map((v) => v.slice(0, 100)),
    };
    return this.throttled(() =>
      this.post<EvolutionSendResponse>(cfg, `/message/sendPoll/${cfg.instanceName}`, body).then(
        (res) => this.toSendResult(res),
      ),
    );
  }

  /**
   * POST /message/sendButtons/{instance}
   *
   * Evolution enforces two rules with a 400, so both are applied here rather
   * than trusted to callers — a rejected send is a lost reply, and the caller
   * that built the buttons is usually not the one that can recover:
   *
   *  1. At most 3 reply buttons.
   *  2. Reply buttons cannot share a message with url/copy/call.
   *
   * Rule 2 is resolved by FAMILY-OF-THE-FIRST-BUTTON: whichever family the
   * caller listed first wins and the other family is dropped. Silently sending
   * half a bubble is worse than it sounds, so the drop is logged — but it is
   * still better than a 400, which sends nothing at all.
   */
  async sendButtons(
    cfg: WhatsAppResolvedConfig,
    args: {
      toE164: string;
      title: string;
      description: string;
      footer?: string;
      buttons: EvolutionButton[];
    },
  ): Promise<SendResult> {
    const buttons = this.capButtons(args.buttons);
    if (!buttons.length) {
      return { ok: false, error: 'No renderable buttons', retryable: false };
    }

    const body: EvolutionSendButtonsBody = {
      number: toEvolutionNumber(args.toE164),
      title: args.title,
      description: args.description,
      ...(args.footer ? { footer: args.footer } : {}),
      buttons,
    };
    return this.throttled(() =>
      this.post<EvolutionSendResponse>(cfg, `/message/sendButtons/${cfg.instanceName}`, body).then(
        (res) => this.toSendResult(res),
      ),
    );
  }

  /** One family only, capped, labels and ids truncated. */
  private capButtons(buttons: EvolutionButton[]): EvolutionButton[] {
    const all = (buttons ?? []).filter(Boolean);
    if (!all.length) return [];

    const family = buttonFamily(all[0]);
    const kept = all.filter((b) => buttonFamily(b) === family);
    const capped = kept.slice(0, family === 'reply' ? WA_BUTTONS.replyMax : WA_BUTTONS.ctaMax);

    if (capped.length < all.length) {
      this.logger.debug(
        `sendButtons: kept ${capped.length}/${all.length} button(s) (family=${family})`,
      );
    }

    return capped.map((b) => {
      const displayText = fit(b.displayText, WA_BUTTONS.label);
      switch (b.type) {
        case 'reply':
          return { type: 'reply', displayText, id: String(b.id).slice(0, WA_ID_MAX) };
        case 'url':
          return { type: 'url', displayText, url: b.url };
        case 'copy':
          return { type: 'copy', displayText, copyCode: b.copyCode };
        case 'call':
          return { type: 'call', displayText, phoneNumber: toEvolutionNumber(b.phoneNumber) };
      }
    });
  }

  /**
   * POST /message/sendCarousel/{instance} — swipeable cards.
   *
   * Present on this build (probe P10) but absent from the v2.3 collection, and
   * currently unreferenced by the render layer. Wired so the shape is recorded
   * in code rather than in a screenshot.
   *
   * @experimental
   */
  async sendCarousel(
    cfg: WhatsAppResolvedConfig,
    args: {
      toE164: string;
      title: string;
      body: string;
      footer?: string;
      cards: EvolutionSendCarouselBody['cards'];
    },
  ): Promise<SendResult> {
    const body: EvolutionSendCarouselBody = {
      number: toEvolutionNumber(args.toE164),
      title: args.title,
      body: args.body,
      ...(args.footer ? { footer: args.footer } : {}),
      cards: (args.cards ?? []).slice(0, 10).map((c) => ({
        ...c,
        buttons: this.capButtons(c.buttons ?? []),
      })),
    };
    return this.throttled(() =>
      this.post<EvolutionSendResponse>(cfg, `/message/sendCarousel/${cfg.instanceName}`, body).then(
        (res) => this.toSendResult(res),
      ),
    );
  }

  /**
   * POST /chat/getBase64FromMediaMessage/{instance} — pull an inbound attachment.
   *
   * Three deliberate departures from every other method here:
   *
   *  1. It does NOT go through `throttled()`. That chain is anti-ban pacing for
   *     SENDS; this call puts nothing on WhatsApp's wire, and queueing it behind
   *     a payroll fan-out would time out the selfie challenge that asked for it.
   *  2. It caps the response at the transport layer, so an unexpectedly large
   *     attachment is refused rather than buffered into the heap.
   *  3. It never lets the response body reach an error string. On this endpoint
   *     `response.data` IS the payload, and `extractError` reads exactly that —
   *     so failures here are classified by status alone.
   */
  async getBase64FromMediaMessage(
    cfg: WhatsAppResolvedConfig,
    args: { waMessageId: string; convertToMp4?: boolean },
  ): Promise<
    | { ok: true; base64: string; mimetype: string | null; fileName: string | null }
    | { ok: false; error: string; retryable: boolean; status?: number }
  > {
    const body: EvolutionGetBase64Body = {
      message: { key: { id: args.waMessageId } },
      convertToMp4: args.convertToMp4 ?? false,
    };

    try {
      const { data } = await axios.post<EvolutionBase64Response>(
        `${cfg.baseUrl}/chat/getBase64FromMediaMessage/${encodeURIComponent(cfg.instanceName)}`,
        body,
        { ...this.requestConfig(cfg), maxContentLength: WA_MEDIA_MAX_BYTES },
      );
      const base64 = data?.base64 ?? data?.media ?? data?.data?.base64 ?? '';
      if (!base64) {
        return { ok: false, error: 'Media response carried no payload', retryable: false };
      }
      return {
        ok: true,
        base64,
        mimetype: data?.mimetype ?? data?.mediaType ?? null,
        fileName: data?.fileName ?? null,
      };
    } catch (e) {
      const status = (e as AxiosError)?.response?.status;
      const code = (e as any)?.code;
      // Deliberately a fixed message: see point 3 above.
      if (status === 400) {
        // Evolution has not stored this message. Nothing to retry towards.
        return { ok: false, error: 'Message not found in the provider store', retryable: false };
      }
      if (code === 'ERR_BAD_RESPONSE' || code === 'ERR_FR_MAX_CONTENT_LENGTH_EXCEEDED') {
        return { ok: false, error: 'Attachment too large', retryable: false };
      }
      const retryable = status === undefined || status === 408 || status === 429 || status >= 500;
      return { ok: false, error: `Media fetch failed (${status ?? code ?? 'network'})`, retryable, status };
    }
  }

  // -------------------------------------------------------------------- chat

  /** POST /chat/markMessageAsRead/{instance} — the blue ticks. */
  async markRead(
    cfg: WhatsAppResolvedConfig,
    remoteJid: string,
    messageId: string,
  ): Promise<void> {
    await this.post(cfg, `/chat/markMessageAsRead/${cfg.instanceName}`, {
      readMessages: [{ remoteJid, fromMe: false, id: messageId }],
    });
  }

  /** POST /chat/sendPresence/{instance} — the "typing…" indicator. */
  async sendPresence(
    cfg: WhatsAppResolvedConfig,
    toE164: string,
    presence: 'composing' | 'available' | 'paused' = 'composing',
  ): Promise<void> {
    await this.post(cfg, `/chat/sendPresence/${cfg.instanceName}`, {
      number: toEvolutionNumber(toE164),
      delay: 1200,
      presence,
    });
  }

  /**
   * POST /webhook/set/{instance}.
   *
   * v2 nests the config under `webhook` and uses camelCase byEvents/base64 —
   * the v1 flat `webhook_by_events` keys do not exist here. The `headers` map
   * is sent back on every callback, which is how the shared secret travels.
   */
  async setWebhook(
    cfg: WhatsAppResolvedConfig,
    args: { url: string; secret: string; events: string[] },
  ): Promise<{ ok: boolean; error?: string }> {
    const res = await this.post(cfg, `/webhook/set/${cfg.instanceName}`, {
      webhook: {
        enabled: true,
        url: args.url,
        headers: {
          'x-hrms-webhook-token': args.secret,
          'Content-Type': 'application/json',
          // ngrok's free tier serves an HTML interstitial to anything that
          // looks like a browser; the callback would then never reach us and
          // the channel would appear silently dead. Harmless elsewhere, but
          // scoped to ngrok hosts so production headers stay clean.
          ...(/\bngrok[-.]/i.test(args.url) ? { 'ngrok-skip-browser-warning': 'true' } : {}),
        },
        byEvents: false,
        base64: false,
        events: args.events,
      },
    });
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  }

  /** GET /webhook/find/{instance} */
  async findWebhook(cfg: WhatsAppResolvedConfig): Promise<any | null> {
    try {
      const { data } = await axios.get(
        `${cfg.baseUrl}/webhook/find/${encodeURIComponent(cfg.instanceName)}`,
        this.requestConfig(cfg),
      );
      return data;
    } catch (e) {
      this.logger.warn(`findWebhook failed: ${this.classifyError(e).message}`);
      return null;
    }
  }

  /**
   * GET /instance/fetchInstances — every instance this API key can see.
   *
   * Returns null when the list cannot be read, which is NOT the same as "no
   * instances": callers must not treat an unreachable server as proof that a
   * configured instance is missing.
   *
   * The response shape has moved between Evolution versions — sometimes a bare
   * array, sometimes `{data: [...]}`, and the name is `instanceName` on older
   * builds and `name` on newer ones — so every shape is accepted rather than
   * pinning one and silently reading undefined.
   */
  async listInstanceNames(cfg: WhatsAppResolvedConfig): Promise<string[] | null> {
    try {
      const { data } = await axios.get(
        `${cfg.baseUrl}/instance/fetchInstances`,
        this.requestConfig(cfg),
      );
      const rows: any[] = Array.isArray(data) ? data : (data?.data ?? []);
      return rows
        .map((r) => {
          const inst = r?.instance ?? r;
          return inst?.instanceName ?? inst?.name ?? '';
        })
        .filter((n: string) => Boolean(n));
    } catch (e) {
      this.logger.warn(`fetchInstances failed: ${this.classifyError(e).message}`);
      return null;
    }
  }

  // ---------------------------------------------------------------- instance

  /** GET /instance/connectionState/{instance} */
  async connectionState(cfg: WhatsAppResolvedConfig): Promise<ConnectionStateResult> {
    try {
      const { data } = await axios.get<EvolutionConnectionStateResponse>(
        `${cfg.baseUrl}/instance/connectionState/${encodeURIComponent(cfg.instanceName)}`,
        this.requestConfig(cfg),
      );
      const raw = (data?.instance?.state ?? data?.state ?? '').toString().toLowerCase();
      const state =
        raw === 'open' || raw === 'connecting' || raw === 'close' ? raw : 'unknown';
      return { state, raw: data };
    } catch (e) {
      const { message } = this.classifyError(e);
      this.logger.warn(`connectionState failed: ${message}`);
      return { state: 'unknown', error: message };
    }
  }

  /** GET /instance/connect/{instance} — returns the pairing QR. */
  async connect(cfg: WhatsAppResolvedConfig): Promise<QrResult> {
    try {
      const { data } = await axios.get<EvolutionConnectResponse>(
        `${cfg.baseUrl}/instance/connect/${encodeURIComponent(cfg.instanceName)}`,
        this.requestConfig(cfg),
      );
      return {
        base64: data?.base64,
        pairingCode: data?.pairingCode ?? data?.code,
        count: data?.count,
      };
    } catch (e) {
      const { message } = this.classifyError(e);
      this.logger.warn(`connect (QR) failed: ${message}`);
      return { error: message };
    }
  }

  /**
   * POST /chat/whatsappNumbers/{instance} — does this number exist on WhatsApp?
   * Returns a map keyed by the E.164 input. Absent key = lookup failed, which the
   * caller must treat as "unknown", never as "does not exist".
   */
  async checkNumbers(
    cfg: WhatsAppResolvedConfig,
    numbersE164: string[],
  ): Promise<Map<string, { exists: boolean; jid?: string }>> {
    const out = new Map<string, { exists: boolean; jid?: string }>();
    if (!numbersE164.length) return out;

    try {
      const { data } = await axios.post<EvolutionNumberCheck[]>(
        `${cfg.baseUrl}/chat/whatsappNumbers/${encodeURIComponent(cfg.instanceName)}`,
        { numbers: numbersE164.map(toEvolutionNumber) },
        this.requestConfig(cfg),
      );
      const rows = Array.isArray(data) ? data : [];
      for (const row of rows) {
        // Evolution echoes the bare-digit form; map it back to the caller's key.
        const digits = (row.number ?? row.jid?.split('@')[0] ?? '').replace(/\D/g, '');
        const key = numbersE164.find((n) => toEvolutionNumber(n) === digits);
        if (key) out.set(key, { exists: Boolean(row.exists), jid: row.jid });
      }
    } catch (e) {
      const { message } = this.classifyError(e);
      this.logger.warn(`whatsappNumbers lookup failed: ${message}`);
    }
    return out;
  }

  // ----------------------------------------------------------------- internal

  private async post<T>(
    cfg: WhatsAppResolvedConfig,
    path: string,
    body: unknown,
  ): Promise<{ ok: true; data: T } | { ok: false; error: string; retryable: boolean; status?: number }> {
    try {
      const { data } = await axios.post<T>(
        `${cfg.baseUrl}${path}`,
        body,
        this.requestConfig(cfg),
      );
      return { ok: true, data };
    } catch (e) {
      const { retryable, message, status } = this.classifyError(e);
      return { ok: false, error: message, retryable, status };
    }
  }

  private toSendResult(
    res:
      | { ok: true; data: EvolutionSendResponse }
      | { ok: false; error: string; retryable: boolean; status?: number },
  ): SendResult {
    if (!res.ok) {
      return { ok: false, error: res.error, retryable: res.retryable, status: res.status };
    }
    return { ok: true, providerMessageId: res.data?.key?.id, retryable: false };
  }

  private requestConfig(cfg: WhatsAppResolvedConfig): AxiosRequestConfig {
    return {
      // Evolution authenticates with a bare `apikey` header — not Authorization,
      // and there is no version prefix in the URL.
      headers: { apikey: cfg.apiKey, 'Content-Type': 'application/json' },
      timeout: cfg.timeoutMs,
    };
  }

  /**
   * Serialise sends and pace them.
   *
   * The pacing is not about protecting Evolution — it is about WhatsApp's own
   * anti-spam heuristics. Blasting a few hundred payslip notices in one second
   * from a single Baileys session is how a number gets banned, so a payroll
   * fan-out is meant to drain over minutes.
   */
  private throttled<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      await this.waitForSlot();
      const now = Date.now();
      this.lastSentAt = now;
      this.recentSends.push(now);
      return fn();
    });
    // Keep the chain alive regardless of individual outcomes.
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async waitForSlot(): Promise<void> {
    const cfg = this.pacing;
    const gapWait = Math.max(0, this.lastSentAt + cfg.minGapMs - Date.now());
    if (gapWait > 0) await sleep(gapWait);

    // Rolling one-minute window.
    for (;;) {
      const cutoff = Date.now() - 60_000;
      this.recentSends = this.recentSends.filter((t) => t > cutoff);
      if (this.recentSends.length < cfg.maxPerMinute) return;
      const oldest = this.recentSends[0];
      await sleep(Math.max(50, oldest + 60_000 - Date.now()));
    }
  }

  /**
   * Pacing values are set by the outbox before a drain run, so the throttle does
   * not need to resolve settings on the hot path (and stays a pure adapter).
   */
  private pacing = { minGapMs: 1200, maxPerMinute: 20 };

  setPacing(minGapMs: number, maxPerMinute: number): void {
    this.pacing = { minGapMs, maxPerMinute };
  }

  /**
   * A 4xx means the request itself is wrong — bad number, unknown instance, bad
   * key — so retrying only burns attempts and delays the FAILED signal. 408 and
   * 429 are the exceptions: those are timing, not correctness.
   */
  classifyError(e: unknown): { retryable: boolean; message: string; status?: number } {
    const err = e as AxiosError<any>;
    const status = err?.response?.status;
    const message = extractError(err);

    if (status === undefined) {
      const code = (err as any)?.code;
      const transient = ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET', 'EAI_AGAIN'];
      return { retryable: transient.includes(code) || !code, message };
    }
    if (status === 408 || status === 429) return { retryable: true, message, status };
    if (status >= 500) return { retryable: true, message, status };
    return { retryable: false, message, status };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function countRows(sections: EvolutionSendListBody['sections']): number {
  return (sections ?? []).reduce((n, s) => n + (s?.rows?.length ?? 0), 0);
}

/**
 * Evolution surfaces Baileys errors in several shapes. Copied from
 * copilot-settings.service.ts so both integrations report failures the same way.
 */
function extractError(e: any): string {
  const d = e?.response?.data;
  const picked =
    d?.response?.message ||
    d?.error?.message ||
    d?.error ||
    d?.message ||
    (typeof d === 'string' ? d : '') ||
    e?.message ||
    'Unknown error';
  return stringifyError(picked).slice(0, 300);
}

/**
 * Evolution reports validation failures as arrays and nested objects
 * (`{ response: { message: [ … ] } }`), and `String(…)` on those yields the
 * useless "[object Object]" that two FAILED rows in production are stamped with.
 * The error text is the only forensic record a failed send leaves behind, so it
 * has to survive whatever shape the gateway chose.
 */
function stringifyError(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(stringifyError).filter(Boolean).join('; ');
  if (v && typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return 'Unserialisable error payload';
    }
  }
  return String(v ?? '');
}

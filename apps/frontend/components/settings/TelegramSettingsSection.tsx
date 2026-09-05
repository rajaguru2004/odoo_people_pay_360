'use client';

import { ReactNode, useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Copy,
  KeyRound,
  Loader2,
  PlugZap,
  RefreshCw,
  Save,
  Send,
  ShieldAlert,
  Users,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import telegramService from '@/services/telegramService';
import { apiErrorMessage } from '@/utils/apiError';
import { TelegramDiagnostics, TelegramSettings, UpdateTelegramSettings } from '@/types/telegram';

/*
 * Like the WhatsApp panel next to it, this is an HR admin page and not an
 * integration console. The two things an operator actually has to supply — the
 * bot token and the group chat id — are first and unmissable; queue mechanics,
 * retry ladders and the geolocation endpoint sit under "Advanced".
 */

function Card({
  title,
  subtitle,
  icon,
  children,
}: {
  title: string;
  subtitle?: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="mb-4 flex items-start gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-primary/10 text-brand-primary">
          {icon}
        </div>
        <div>
          <h3 className="font-semibold text-slate-800">{title}</h3>
          {subtitle && <p className="text-sm text-slate-500">{subtitle}</p>}
        </div>
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <p className="text-sm font-medium text-slate-700">{label}</p>
        {hint && <p className="text-xs text-slate-400">{hint}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-brand-primary/30 ${
          checked ? 'bg-brand-primary' : 'bg-slate-300'
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform duration-200 ${
            checked ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
      </button>
    </div>
  );
}

function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1 block text-sm font-medium text-slate-700">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}

const inputClass =
  'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary/30';

/** Read-only, selectable, with a copy button. Same role as the WhatsApp panel's. */
function CopyRow({ value, empty }: { value: string; empty?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      toast.error('Could not copy — select the text and copy it manually.');
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex items-center gap-2">
      <code
        className={`flex-1 select-all overflow-x-auto whitespace-nowrap rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs ${
          value ? 'text-slate-700' : 'text-slate-400'
        }`}
      >
        {value || empty || '—'}
      </code>
      <button
        type="button"
        onClick={copy}
        disabled={!value}
        className="shrink-0 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {copied ? (
          <span className="flex items-center gap-1 text-emerald-600">
            <CheckCircle2 className="h-3.5 w-3.5" /> Copied
          </span>
        ) : (
          <span className="flex items-center gap-1">
            <Copy className="h-3.5 w-3.5" /> Copy
          </span>
        )}
      </button>
    </div>
  );
}

/**
 * `loginAlertRoles` is the one field whose read and write shapes differ: the
 * backend returns a split array but accepts a CSV string, because it is a CSV
 * row in `system_settings`. That asymmetry is a white screen waiting to happen
 * — anything that hands this component the written shape back (a response echo,
 * a cached DTO) would reach `.join` on a string. Normalising on ingest is one
 * line and removes the whole class.
 */
function normalize(raw: TelegramSettings): TelegramSettings {
  const roles = raw.loginAlertRoles;
  return {
    ...raw,
    loginAlertRoles: Array.isArray(roles)
      ? roles
      : String(roles ?? '')
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean),
  };
}

export default function TelegramSettingsSection() {
  const [cfg, setCfg] = useState<TelegramSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [diag, setDiag] = useState<TelegramDiagnostics | null>(null);
  const [advanced, setAdvanced] = useState(false);

  /**
   * The token is write-only, so it is NOT part of `cfg` — there is nothing to
   * read back and nothing to pre-fill. An empty box means "leave whatever is
   * stored alone", which is why it is never sent unless the admin typed
   * something.
   */
  const [botToken, setBotToken] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await telegramService.getSettings();
      setCfg(res.data ? normalize(res.data) : null);
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not load the Telegram settings'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function patch(next: Partial<TelegramSettings>) {
    setCfg((c) => (c ? { ...c, ...next } : c));
  }

  async function save() {
    if (!cfg) return;
    setSaving(true);
    try {
      const dto: UpdateTelegramSettings = {
        enabled: cfg.enabled,
        inboundEnabled: cfg.inboundEnabled,
        linkingEnabled: cfg.linkingEnabled,
        notificationsEnabled: cfg.notificationsEnabled,
        alertChatId: cfg.alertChatId,
        loginAlertsEnabled: cfg.loginAlertsEnabled,
        loginAlertFailures: cfg.loginAlertFailures,
        loginAlertGeo: cfg.loginAlertGeo,
        geoLookupUrl: cfg.geoLookupUrl,
        loginAlertRoles: cfg.loginAlertRoles.join(','),
        loginAlertFailureMaxPerHour: cfg.loginAlertFailureMaxPerHour,
        redirectAllTo: cfg.redirectAllTo,
        retentionDays: cfg.retentionDays,
      };
      // Only when typed. Sending '' would be a value, and the backend would
      // have no way to tell "leave it" from "clear it".
      if (botToken.trim()) dto.botToken = botToken.trim();

      const res = await telegramService.updateSettings(dto);
      setCfg(res.data ? normalize(res.data) : cfg);
      setBotToken('');
      toast.success('Telegram settings saved');
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not save the Telegram settings'));
    } finally {
      setSaving(false);
    }
  }

  async function clearToken() {
    setBusy('clear');
    try {
      const res = await telegramService.updateSettings({ clearBotToken: true });
      setCfg(res.data ? normalize(res.data) : cfg);
      setBotToken('');
      setDiag(null);
      toast.success('Bot token removed');
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not remove the bot token'));
    } finally {
      setBusy(null);
    }
  }

  async function check() {
    setBusy('check');
    try {
      const res = await telegramService.diagnostics();
      setDiag(res.data ?? null);
      if (!res.data?.bot) {
        toast.error('Telegram did not recognise that bot token.');
      } else if (res.data.chat?.ok) {
        toast.success(`@${res.data.bot.username} can post to “${res.data.chat.title}”`);
      } else {
        // The bot being fine is NOT the answer the admin needs when the chat is
        // the broken half — say which half failed.
        toast.error(res.data.chat?.error ?? 'The alert chat could not be resolved.');
      }
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not reach Telegram'));
    } finally {
      setBusy(null);
    }
  }

  async function connectWebhook() {
    setBusy('webhook');
    try {
      const res = await telegramService.registerWebhook();
      toast.success(`Telegram now posts to ${res.data?.url ?? 'this system'}.`);
      await load();
      await check();
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not register the webhook'));
    } finally {
      setBusy(null);
    }
  }

  async function sendTest() {
    setBusy('test');
    try {
      const res = await telegramService.testMessage();
      toast.success(`Sent to ${res.data?.chatId ?? 'the group'} — check the group.`);
    } catch (e) {
      // The endpoint sends synchronously, so this is Telegram's own refusal
      // rather than a queue acknowledgement. Kept long on purpose: it names the
      // four causes of "chat not found", which the API itself does not.
      toast.error(apiErrorMessage(e, 'Could not send a test message'), { duration: 12_000 });
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white p-5 text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading Telegram settings…
      </div>
    );
  }

  if (!cfg) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-500">
        Telegram settings are unavailable on this deployment.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card
        title="Telegram bot"
        subtitle="The bot that posts HR updates and login alerts."
        icon={<Bot className="h-5 w-5" />}
      >
        <Toggle
          label="Telegram enabled"
          hint="Off means nothing is sent, whatever else is switched on below."
          checked={cfg.enabled}
          onChange={(v) => patch({ enabled: v })}
        />

        <Field
          label="Bot token"
          htmlFor="telegram-bot-token"
          hint={
            cfg.botTokenConfigured
              ? `A token is stored (${cfg.botTokenMasked}${
                  cfg.botTokenSource === 'env' ? ', from the environment' : ''
                }). Leave this empty to keep it.`
              : 'From @BotFather. Encrypted when saved, and never shown again.'
          }
        >
          <div className="flex gap-2">
            <input
              id="telegram-bot-token"
              type="password"
              autoComplete="off"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              placeholder={cfg.botTokenConfigured ? '•••••••• (unchanged)' : '123456789:AA…'}
              className={inputClass}
            />
            {cfg.botTokenConfigured && (
              <button
                type="button"
                onClick={clearToken}
                disabled={busy === 'clear'}
                className="shrink-0 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                {busy === 'clear' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Remove'}
              </button>
            )}
          </div>
        </Field>

        {cfg.botTokenSource === 'env' && (
          <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-2.5 text-xs text-amber-800">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            This token is coming from the environment file, which is tracked in version
            control. Save it here instead, then remove <code>TELEGRAM_BOT_TOKEN</code> from it.
          </p>
        )}

        <Field
          label="Alert group chat ID"
          htmlFor="telegram-chat-id"
          hint="Where login alerts are posted. A group ID is negative, e.g. -5544539023. Add the bot to the group first — a bot cannot post anywhere it is not a member."
        >
          <input
            id="telegram-chat-id"
            value={cfg.alertChatId}
            onChange={(e) => patch({ alertChatId: e.target.value })}
            placeholder="-5544539023"
            className={inputClass}
          />
        </Field>

        <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-3">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg bg-brand-primary px-3 py-2 text-xs font-medium text-white transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save
          </button>
          <button
            type="button"
            onClick={check}
            disabled={busy === 'check' || !cfg.botTokenConfigured}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${busy === 'check' ? 'animate-spin' : ''}`} />
            Check bot &amp; chat
          </button>
          <button
            type="button"
            onClick={sendTest}
            disabled={busy === 'test' || !cfg.enabled || !cfg.alertChatId}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50"
          >
            {busy === 'test' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            Send test message
          </button>
        </div>

        {diag && (
          <div className="space-y-1.5 rounded-lg border border-slate-200 bg-slate-50/60 p-3 text-xs">
            {diag.bot ? (
              <p className="flex items-center gap-2 text-emerald-700">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> Connected as @
                {diag.bot.username}
              </p>
            ) : (
              <p className="flex items-center gap-2 text-rose-700">
                <XCircle className="h-3.5 w-3.5 shrink-0" /> Telegram did not recognise that
                token.
              </p>
            )}

            {/* The half that actually broke in production. Showing the STORED id
                next to the verdict is the whole point: a wrong id is obvious on
                sight, and a right one is confirmed by the group's real title. */}
            {diag.chat?.ok ? (
              <p className="flex items-center gap-2 text-emerald-700">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                Chat <code>{diag.chat.chatId}</code> is “{diag.chat.title}” ({diag.chat.type})
              </p>
            ) : (
              diag.chat && (
                <p className="flex items-start gap-2 text-rose-700">
                  <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    Chat <code>{diag.chat.chatId || '(not set)'}</code>: {diag.chat.error}
                    {/chat not found/i.test(diag.chat.error ?? '') && (
                      <>
                        {' '}
                        Add @{diag.bot?.username ?? 'the bot'} to that group, or check the id —
                        a supergroup id starts with <code>-100</code>.
                      </>
                    )}
                  </span>
                </p>
              )
            )}

            {/* A migrated group answers getChat on the old id but reports a new
                one. Storing the new id is the durable fix. */}
            {diag.chat?.ok && diag.chat.resolvedId && diag.chat.resolvedId !== diag.chat.chatId && (
              <p className="flex items-start gap-2 text-amber-700">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                Telegram reports this chat as <code>{diag.chat.resolvedId}</code>. Save that id
                above — the stored one may stop working.
              </p>
            )}

            {diag.webhook?.last_error_message && (
              <p className="text-amber-700">
                Last delivery error: {diag.webhook.last_error_message}
              </p>
            )}
          </div>
        )}
      </Card>

      <Card
        title="Login alerts"
        subtitle="Every sign-in posted to the group above, with the address and device it came from."
        icon={<ShieldAlert className="h-5 w-5" />}
      >
        <Toggle
          label="Post an alert on every login"
          hint="Who signed in, when, from which IP and on what device."
          checked={cfg.loginAlertsEnabled}
          onChange={(v) => patch({ loginAlertsEnabled: v })}
        />
        <Toggle
          label="Also alert on failed logins"
          hint={`Wrong password, disabled account, unknown email. Capped at ${cfg.loginAlertFailureMaxPerHour} per address per hour, so the group cannot be flooded from outside.`}
          checked={cfg.loginAlertFailures}
          onChange={(v) => patch({ loginAlertFailures: v })}
        />
        <Toggle
          label="Look up the country and network"
          hint="Sends the login IP to a third-party geolocation service. Private and office-internal addresses are never sent."
          checked={cfg.loginAlertGeo}
          onChange={(v) => patch({ loginAlertGeo: v })}
        />

        <Field
          label="Only alert for these roles"
          htmlFor="telegram-alert-roles"
          hint="Comma separated, e.g. ADMIN,HR_MANAGER. Leave empty to alert on every role."
        >
          <input
            id="telegram-alert-roles"
            value={cfg.loginAlertRoles.join(',')}
            onChange={(e) =>
              patch({
                loginAlertRoles: e.target.value
                  .split(',')
                  .map((s) => s.trim().toUpperCase())
                  .filter(Boolean),
              })
            }
            placeholder="Every role"
            className={inputClass}
          />
        </Field>

        {!cfg.alertChatId && (
          <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-2.5 text-xs text-amber-800">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            No group chat ID is set above, so nothing is posted no matter what is switched on
            here.
          </p>
        )}
      </Card>

      <Card
        title="Employee messages"
        subtitle="HR updates delivered to staff who have linked their own Telegram account."
        icon={<Users className="h-5 w-5" />}
      >
        <Toggle
          label="Send HR updates over Telegram"
          hint="The same updates as WhatsApp — leave decisions, payslips, approvals — to anyone who has linked their account."
          checked={cfg.notificationsEnabled}
          onChange={(v) => patch({ notificationsEnabled: v })}
        />
        <Toggle
          label="Let employees link their own account"
          hint="Shows the Telegram section on their profile page."
          checked={cfg.linkingEnabled}
          onChange={(v) => patch({ linkingEnabled: v })}
        />
        <Toggle
          label="Accept messages from Telegram"
          hint="Required for linking: the six-digit code is redeemed by a message the bot receives."
          checked={cfg.inboundEnabled}
          onChange={(v) => patch({ inboundEnabled: v })}
        />

        <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/60 p-4">
          <div className="flex items-start gap-2">
            <PlugZap className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
            <div>
              <p className="text-sm font-medium text-slate-700">Where incoming messages arrive</p>
              <p className="text-xs text-slate-500">
                Telegram has to be told to post here before <code>/link</code> can work. The
                button generates the shared secret and registers the address in one step.
              </p>
            </div>
          </div>
          <Field label="Secret header Telegram sends">
            <CopyRow value="x-telegram-bot-api-secret-token" />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={connectWebhook}
              disabled={busy === 'webhook' || !cfg.botTokenConfigured}
              className="inline-flex items-center gap-2 rounded-lg bg-brand-primary px-3 py-2 text-xs font-medium text-white transition-colors hover:opacity-90 disabled:opacity-50"
            >
              {busy === 'webhook' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <PlugZap className="h-3.5 w-3.5" />
              )}
              Connect automatically
            </button>
            <span className="flex items-center gap-1.5 text-xs text-slate-500">
              {cfg.webhookSecretConfigured ? (
                <>
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> A secret is stored.
                </>
              ) : (
                <>
                  <XCircle className="h-3.5 w-3.5 text-slate-400" /> No secret yet.
                </>
              )}
            </span>
          </div>
        </div>
      </Card>

      <div className="rounded-xl border border-slate-200 bg-white">
        <button
          type="button"
          onClick={() => setAdvanced((a) => !a)}
          className="flex w-full items-center gap-2 px-5 py-3 text-left text-sm font-medium text-slate-700"
        >
          <KeyRound className="h-4 w-4 text-slate-400" />
          Advanced
          <span className="ml-auto text-xs text-slate-400">{advanced ? 'Hide' : 'Show'}</span>
        </button>

        {advanced && (
          <div className="space-y-4 border-t border-slate-200 p-5">
            <Field
              label="Send everything to this chat instead"
              htmlFor="telegram-redirect"
              hint="Test catcher. While set, EVERY message — staff updates included — goes here and nobody else hears from the bot."
            >
              <input
                id="telegram-redirect"
                value={cfg.redirectAllTo}
                onChange={(e) => patch({ redirectAllTo: e.target.value })}
                placeholder="Not set"
                className={inputClass}
              />
            </Field>

            {cfg.redirectAllTo && (
              <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-2.5 text-xs text-amber-800">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                Test mode is on. Staff are not receiving anything.
              </p>
            )}

            <Field
              label="Failed-login alerts per address, per hour"
              htmlFor="telegram-failure-cap"
              hint="Above this, alerts from that address pause for the rest of the hour and the group is told once why."
            >
              <input
                id="telegram-failure-cap"
                type="number"
                min={1}
                max={1000}
                value={cfg.loginAlertFailureMaxPerHour}
                onChange={(e) =>
                  patch({ loginAlertFailureMaxPerHour: Number(e.target.value) || 1 })
                }
                className={inputClass}
              />
            </Field>

            <Field
              label="Geolocation service"
              htmlFor="telegram-geo-url"
              hint="{ip} is replaced with the address being looked up. Point this at your own service if you would rather not use a third party."
            >
              <input
                id="telegram-geo-url"
                value={cfg.geoLookupUrl}
                onChange={(e) => patch({ geoLookupUrl: e.target.value })}
                className={inputClass}
              />
            </Field>

            <Field
              label="Keep sent messages for"
              htmlFor="telegram-retention"
              hint="Days. Delivered rows are swept nightly after this."
            >
              <input
                id="telegram-retention"
                type="number"
                min={1}
                max={3650}
                value={cfg.retentionDays}
                onChange={(e) => patch({ retentionDays: Number(e.target.value) || 1 })}
                className={inputClass}
              />
            </Field>

            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-lg bg-brand-primary px-3 py-2 text-xs font-medium text-white transition-colors hover:opacity-90 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

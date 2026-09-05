'use client';

import { ReactNode, useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Clock,
  Copy,
  FlaskConical,
  Languages,
  Loader2,
  MessageCircle,
  MessagesSquare,
  PlugZap,
  ShieldCheck,
  QrCode,
  RefreshCw,
  Save,
  Send,
  Settings2,
  Users,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import whatsappService from '@/services/whatsappService';
import WhatsAppActionSwitches from './WhatsAppActionSwitches';
import {
  UpdateWhatsAppSettings,
  WhatsAppConnection,
  WhatsAppEnrollResult,
  WhatsAppIdentityStats,
  WhatsAppOutboxRow,
  WhatsAppQr,
  WhatsAppSettings,
  WhatsAppTemplate,
  WhatsAppTestSendResult,
  WhatsAppWebhookConfig,
} from '@/types/whatsapp';
import { apiErrorMessage } from '@/utils/apiError';

/*
 * This is an HR admin page, not an integration console. Everything the operator
 * cannot act on — the gateway vendor, instance names, queue mechanics, retry
 * ladders, template keys — is either absent or tucked behind "Setup", which
 * only opens itself when something actually needs fixing.
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
        // The caption is a sibling, not a <label>, so without this the control
        // is announced as an unnamed switch and cannot be addressed by name.
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

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-slate-700">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}

/**
 * A value the admin has to move into another system by hand.
 *
 * Read-only and selectable rather than an input: these are derived, and an
 * editable-looking box invites someone to "fix" a URL here and wonder why it
 * reverts. The copy button matters more than it looks — the webhook secret is
 * 64 hex characters and is shown exactly once.
 */
function CopyRow({ value, empty }: { value: string; empty?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard access is blocked on insecure origins and in some browsers.
      // The text is selectable either way, so say so instead of failing silently.
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
 * Where incoming messages arrive — the address that has to be set in the
 * WhatsApp service before the chatbot can answer anything.
 *
 * Two ways to get it there, because deployments differ: the button registers it
 * over Evolution's API, and the copy boxes cover an instance whose webhook is
 * managed by hand or by config file. Both are shown at once rather than behind
 * a mode switch, since which one applies is not something this page can know.
 *
 * `savedBase` is the callback address as STORED, not as typed: the derived URL
 * updates live while the admin edits, but the "already wired up" verdict below
 * it is only meaningful against what the server actually has.
 */
function WebhookPanel({
  wh,
  typedBase,
  savedBase,
  loading,
  onRefresh,
}: {
  wh: WhatsAppWebhookConfig | null;
  typedBase: string;
  savedBase: string;
  loading: boolean;
  onRefresh: () => void;
}) {
  const [registering, setRegistering] = useState(false);
  const [secret, setSecret] = useState('');

  const base = typedBase.trim().replace(/\/+$/, '');
  const path = wh?.path ?? '/whatsapp/webhook';
  const url = base ? `${base}${path}` : '';
  const unsaved = base !== savedBase.trim().replace(/\/+$/, '');

  const register = async () => {
    setRegistering(true);
    try {
      const res = await whatsappService.registerWebhook();
      setSecret(res.data?.secret ?? '');
      toast.success('WhatsApp now points at this system.');
      onRefresh();
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Could not set the callback address.'));
    } finally {
      setRegistering(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/60 p-4">
      <div className="flex items-start gap-2">
        <PlugZap className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
        <div>
          <p className="text-sm font-medium text-slate-700">Where incoming messages arrive</p>
          <p className="text-xs text-slate-500">
            The WhatsApp service posts every message to this address. Without it the chatbot
            never hears anything, no matter what is switched on above.
          </p>
        </div>
      </div>

      <Field label="Callback address">
        <CopyRow value={url} empty="Set the API address above first" />
      </Field>

      {unsaved && base && (
        <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-2.5 text-xs text-amber-800">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Save this page before connecting — the button below uses the saved address, not the
          one you just typed.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Header name" hint="The service must send the secret under this header.">
          <CopyRow value={wh?.headerName ?? 'x-hrms-webhook-token'} />
        </Field>
        <Field label="Events to subscribe to">
          <CopyRow value={(wh?.events ?? []).join(', ')} />
        </Field>
      </div>

      {/* Shown once. There is no decrypt-to-UI path, so a closed page is gone. */}
      {secret && (
        <Field
          label="Secret"
          hint="Shown once and never again. Only needed if you configure the service by hand — the button below already sent it."
        >
          <CopyRow value={secret} />
        </Field>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-3">
        <button
          type="button"
          onClick={register}
          disabled={registering || !wh?.configured}
          className="inline-flex items-center gap-2 rounded-lg bg-brand-primary px-3 py-2 text-xs font-medium text-white transition-colors hover:opacity-90 disabled:opacity-50"
        >
          {registering ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <PlugZap className="h-3.5 w-3.5" />
          )}
          Connect automatically
        </button>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 transition-colors hover:bg-white disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Check
        </button>
        <span className="text-xs text-slate-500">
          Rotates the secret and tells the service where to post.
        </span>
      </div>

      {/* The rotated secret is stored in THIS system's database, but the address
          above may belong to a different deployment sharing one WhatsApp
          account. That deployment keeps the old secret and starts answering 401
          on every callback — inbound stops, with nothing in this UI to show it. */}
      <p className="text-xs text-slate-500">
        Connect from the same environment the address above points at. Doing it from another
        one rotates the secret out from under that deployment and its incoming messages stop.
      </p>

      <WebhookVerdict wh={wh} loading={loading} />
    </div>
  );
}

/** The one question worth answering: is inbound actually wired up right now? */
function WebhookVerdict({ wh, loading }: { wh: WhatsAppWebhookConfig | null; loading: boolean }) {
  if (loading && !wh) {
    return <p className="text-xs text-slate-400">Checking…</p>;
  }
  if (!wh) return null;

  // Checked before everything else: with a wrong account name, "connected" and
  // "not connected" are both answers about somebody else's WhatsApp account,
  // and pressing Connect would rotate that account's secret.
  if (wh.unknownInstance) {
    return (
      <p className="flex items-start gap-2 text-xs text-rose-700">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          The account name <code className="font-mono">{wh.unknownInstance.configured}</code> does
          not exist on the WhatsApp service. Available:{' '}
          <code className="font-mono">
            {wh.unknownInstance.available.join(', ') || 'none'}
          </code>
          . Fix it under Setup before connecting — otherwise you would reconfigure a different
          account and rotate its secret.
        </span>
      </p>
    );
  }

  if (!wh.configured) {
    return (
      <p className="text-xs text-slate-500">
        Fill in the service address, account name and access key above, then save, to check this.
      </p>
    );
  }
  if (wh.error) {
    return (
      <p className="flex items-start gap-2 text-xs text-amber-700">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        Could not ask the WhatsApp service what it has on file: {wh.error}
      </p>
    );
  }
  if (wh.matches) {
    return (
      <div className="space-y-1.5">
        <p className="flex items-start gap-2 text-xs text-emerald-700">
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Connected — the service is posting here
          {wh.registeredEnabled === false && ', but the callback is switched off on their side'}.
          {!wh.secretConfigured && ' No secret is set yet, so messages will be rejected.'}
        </p>
        {/* Right URL, wrong subscription: some things arrive and others never
            do, which reads as an intermittent bug rather than a setting. */}
        {wh.missingEvents.length > 0 && (
          <p className="flex items-start gap-2 text-xs text-amber-700">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              The service is not subscribed to{' '}
              <code className="font-mono">{wh.missingEvents.join(', ')}</code>. Messages still
              arrive, but these updates never will — press Connect automatically to fix the
              subscription.
            </span>
          </p>
        )}
      </div>
    );
  }
  if (wh.registeredUrl) {
    return (
      <p className="flex items-start gap-2 text-xs text-amber-700">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        The service is posting somewhere else:{' '}
        <code className="break-all font-mono">{wh.registeredUrl}</code>
      </p>
    );
  }
  // The client returns null both when the service has no webhook and when it
  // could not be reached at all, so this wording must cover both rather than
  // asserting the first and sending someone to debug the wrong thing.
  return (
    <p className="flex items-start gap-2 text-xs text-amber-700">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      The service reports no callback address — either it has none, or it could not be
      reached. Nothing will arrive until this reads &ldquo;Connected&rdquo;.
    </p>
  );
}

/**
 * Show the admin what is actually STORED in the test-recipient field.
 *
 * The server reports `redirectAllTo: ''` for a value it could not parse, so
 * binding the input straight to it renders an empty box while sending is halted
 * because of what is in that box. The banner then reads "fix or clear it under
 * Setup" and points at a field that already looks clear — the state is
 * undiagnosable and unfixable from the product, which is how one live channel
 * stayed dark for 19 days. Seeding from the raw value puts the offending text
 * back in front of the person who has to correct it, and the ordinary save path
 * (which sends this field verbatim) then clears or fixes it.
 */
function hydrate(s: WhatsAppSettings | null): WhatsAppSettings | null {
  if (!s) return s;
  return {
    ...s,
    ...(s.redirectMisconfigured && s.redirectAllToRaw
      ? { redirectAllTo: s.redirectAllToRaw }
      : {}),
    // Same failure shape, same treatment — an unreadable copy number would
    // otherwise render as an empty box that quietly sends nothing.
    ...(s.carbonCopyMisconfigured && s.carbonCopyToRaw
      ? { carbonCopyTo: s.carbonCopyToRaw }
      : {}),
  };
}

/**
 * Every field this page may write.
 *
 * One list, consumed by save(). Adding a control therefore cannot forget to
 * save it, which is the failure this replaces.
 */
const EDITABLE_KEYS = [
  'enabled',
  'baseUrl',
  'instanceName',
  'adminNumber',
  'defaultRegion',
  'appBaseUrl',
  'publicApiUrl',
  'requireOptIn',
  'requireVerified',
  'allowGenericFallback',
  'disabledTemplates',
  'interactiveMode',
  'redirectAllTo',
  'autoEnroll',
  'carbonCopyEnabled',
  'carbonCopyTo',
  'dryRun',
  // Two-way
  'inboundEnabled',
  'enrollmentEnabled',
  'mutationsEnabled',
  'approvalsEnabled',
  'requirePinForSensitive',
  'approvalTokenTtlMinutes',
  'ratePerPhone5Min',
  'ratePerUserHour',
  'rateMutations10Min',
  // Verification
  'attendanceVerification',
  'selfieDailyCap',
  'selfieChallengeSeconds',
  'verificationLinkTtlMinutes',
  // Voice and quiet hours
  'supportContact',
  'quietHoursStart',
  'quietHoursEnd',
  'quietHoursOverrideTemplates',
  // Typed against the WRITE contract, not the read shape. A control for a
  // field the API does not accept is now a compile error rather than a 400
  // that kills the whole save.
] as const satisfies readonly (keyof UpdateWhatsAppSettings & keyof WhatsAppSettings)[];

const inputCls =
  'w-full h-10 px-3 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/30 transition-all';

/** Dial codes shown in the preview hint below the country select. */
const REGION_DIAL: Record<string, string> = {
  IN: '91', AE: '971', SA: '966', OM: '968', QA: '974', KW: '965',
  BH: '973', MY: '60',  SG: '65',  PH: '63',  LK: '94',  BD: '880',
  PK: '92',  NP: '977', GB: '44',  US: '1',   AU: '61',  CA: '1',
  ZA: '27',  NG: '234',
};


/** Delivery states in words an HR admin uses, not queue states. */
const DELIVERY_LABEL: Record<string, { text: string; cls: string }> = {
  SENT: { text: 'Delivered', cls: 'bg-emerald-50 text-emerald-700' },
  QUEUED: { text: 'Waiting to send', cls: 'bg-amber-50 text-amber-700' },
  SENDING: { text: 'Sending', cls: 'bg-sky-50 text-sky-700' },
  FAILED: { text: 'Could not deliver', cls: 'bg-rose-50 text-rose-700' },
  SKIPPED: { text: 'Not sent', cls: 'bg-slate-100 text-slate-600' },
};

export default function WhatsAppSettingsSection() {
  const [cfg, setCfg] = useState<WhatsAppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Kept out of `cfg` on purpose: the real key never reaches the browser, so it
  // can never round-trip through this form.
  const [newApiKey, setNewApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);

  const [conn, setConn] = useState<WhatsAppConnection | null>(null);
  const [qr, setQr] = useState<WhatsAppQr | null>(null);
  const [qrLoading, setQrLoading] = useState(false);

  const [webhook, setWebhook] = useState<WhatsAppWebhookConfig | null>(null);
  const [webhookLoading, setWebhookLoading] = useState(false);

  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);
  const [testPhone, setTestPhone] = useState('');
  const [testTemplate, setTestTemplate] = useState('leave_approved');
  const [testResult, setTestResult] = useState<WhatsAppTestSendResult | null>(null);
  const [testing, setTesting] = useState(false);

  const [stats, setStats] = useState<WhatsAppIdentityStats | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [enrollPreview, setEnrollPreview] = useState<WhatsAppEnrollResult | null>(null);
  const [enrollConsent, setEnrollConsent] = useState(false);

  const [recent, setRecent] = useState<WhatsAppOutboxRow[]>([]);
  const [recentLoading, setRecentLoading] = useState(false);

  const patch = (p: Partial<WhatsAppSettings>) => setCfg((c) => (c ? { ...c, ...p } : c));

  // Per-update switches. Stored as the list that is OFF, so a newly added
  // update is on by default and nobody has to remember to enable it.
  const disabled = cfg?.disabledTemplates ?? [];
  const isUpdateOn = (key: string) => !disabled.includes(key);

  const toggleUpdate = (key: string) =>
    patch({
      disabledTemplates: disabled.includes(key)
        ? disabled.filter((k) => k !== key)
        : [...disabled, key],
    });

  const selectable = templates;
  const setAllUpdates = (on: boolean) =>
    patch({ disabledTemplates: on ? [] : selectable.map((t) => t.key) });

  const onCount = selectable.filter((t) => isUpdateOn(t.key)).length;

  // Preserve registry order within each group; group order follows first appearance.
  const groupedTemplates = Array.from(
    templates.reduce((m, t) => {
      m.set(t.group, [...(m.get(t.group) ?? []), t]);
      return m;
    }, new Map<string, WhatsAppTemplate[]>()),
  );

  const loadRecent = useCallback(async () => {
    setRecentLoading(true);
    try {
      const res = await whatsappService.outbox({ take: 15 });
      setRecent(res.data?.rows ?? []);
    } catch {
      /* informational only */
    } finally {
      setRecentLoading(false);
    }
  }, []);

  const loadWebhook = useCallback(async () => {
    setWebhookLoading(true);
    try {
      const res = await whatsappService.webhookConfig();
      setWebhook(res.data ?? null);
    } catch {
      // Leave the last known state rather than blanking the panel: the URL to
      // copy is derived locally and stays useful even when the check fails.
    } finally {
      setWebhookLoading(false);
    }
  }, []);

  const refreshConnection = useCallback(async () => {
    try {
      const res = await whatsappService.connectionState();
      setConn(res.data ?? null);
      // Only nag about setup when it is genuinely incomplete.
      if (res.data && !res.data.configured) setSetupOpen(true);
    } catch {
      setConn({
        state: 'unknown',
        configured: false,
        sendingEnabled: false,
        error: 'Could not reach the server.',
      });
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [s, t, st] = await Promise.all([
          whatsappService.getSettings(),
          whatsappService.templates(),
          whatsappService.identityStats(),
        ]);
        setCfg(hydrate(s.data ?? null));
        setTemplates(t.data ?? []);
        setStats(st.data ?? null);
        if (s.data?.adminNumber) setTestPhone(s.data.adminNumber);
      } catch {
        toast.error('Could not load WhatsApp settings');
      } finally {
        setLoading(false);
      }
    })();
    void refreshConnection();
    void loadRecent();
  }, [refreshConnection, loadRecent]);

  // Deferred until Setup is actually opened: answering it costs a round trip to
  // the WhatsApp service, which nobody should pay for on a page they opened to
  // flip one notification switch.
  useEffect(() => {
    if (setupOpen && !webhook && !webhookLoading) void loadWebhook();
  }, [setupOpen, webhook, webhookLoading, loadWebhook]);

  // Sending is halted by a field that lives inside "Setup", and Setup is closed
  // by default. Leaving it closed means the banner points at a control the
  // reader cannot see — the last link in the chain that made this state
  // unfixable from the product.
  useEffect(() => {
    if (cfg?.redirectMisconfigured) setSetupOpen(true);
  }, [cfg?.redirectMisconfigured]);

  async function save() {
    if (!cfg) return;
    setSaving(true);
    try {
      // Built from ONE declared list rather than a hand-written literal.
      // The literal is how this page drifted in the first place: six switches
      // the API already accepted had no control here, and every control added
      // afterwards was one more chance to forget the matching save line.
      const dto: UpdateWhatsAppSettings = Object.fromEntries(
        EDITABLE_KEYS.map((k) => [k, cfg[k]]),
      ) as UpdateWhatsAppSettings;
      if (clearKey) dto.clearApiKey = true;
      else if (newApiKey.trim()) dto.apiKey = newApiKey.trim();

      const res = await whatsappService.updateSettings(dto);
      setCfg(hydrate(res.data ?? cfg));
      setNewApiKey('');
      setClearKey(false);
      toast.success('Saved');
      void refreshConnection();
      // The callback address may have just changed, and the panel's "already
      // wired up" verdict is only meaningful against the SAVED value.
      if (setupOpen) void loadWebhook();
      // Re-read the list: the server drops keys it does not recognise, so this
      // is what the switches will actually do from now on.
      void whatsappService.templates().then((t) => setTemplates(t.data ?? []));
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Could not save'));
    } finally {
      setSaving(false);
    }
  }

  /**
   * Clear the test recipient on its own, without saving the rest of the form.
   *
   * Deliberately a single-key write rather than a reuse of save(): the channel
   * is down, and the one thing that must not stand between an admin and turning
   * it back on is an unrelated invalid field somewhere else on this page.
   */
  async function clearRedirect() {
    if (!cfg) return;
    setSaving(true);
    try {
      const res = await whatsappService.updateSettings({ redirectAllTo: '' });
      setCfg(hydrate(res.data ?? cfg));
      toast.success('Test recipient cleared — your team will be messaged normally');
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Could not clear the test recipient'));
    } finally {
      setSaving(false);
    }
  }

  async function showQr() {
    setQrLoading(true);
    try {
      const res = await whatsappService.qr();
      setQr(res.data ?? null);
      if (res.data?.error) toast.error(res.data.error);
    } catch {
      toast.error('Could not load the pairing code');
    } finally {
      setQrLoading(false);
    }
  }

  async function runTest(previewOnly: boolean) {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await whatsappService.testSend({
        phone: testPhone || undefined,
        templateKey: testTemplate,
        previewOnly,
      });
      setTestResult(res.data ?? null);
      if (!previewOnly) {
        toast.success(res.data?.queued ? 'Test message sent' : (res.data?.reason ?? 'Not sent'));
        void loadRecent();
      }
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Could not send the test'));
    } finally {
      setTesting(false);
    }
  }

  /**
   * Preview first, always. Committing links numbers for the whole team and can
   * record consent on their behalf — not something to find out afterwards.
   */
  async function previewEnroll() {
    setEnrolling(true);
    try {
      const res = await whatsappService.enrollFromEmployees({ commit: false });
      setEnrollPreview(res.data ?? null);
      if (res.data && res.data.results.length === 0) {
        toast.error('No employee has both a login and a phone number on their profile.');
      }
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Could not read your team’s numbers'));
    } finally {
      setEnrolling(false);
    }
  }

  async function commitEnroll() {
    setEnrolling(true);
    try {
      const res = await whatsappService.enrollFromEmployees({
        commit: true,
        confirmConsent: enrollConsent,
      });
      const added = (res.data?.results ?? []).filter((r) => r.outcome !== 'skipped').length;
      toast.success(
        enrollConsent
          ? `${added} number(s) added — they will receive updates from now on`
          : `${added} number(s) linked. Each person still has to agree from their profile.`,
      );
      setEnrollPreview(null);
      setEnrollConsent(false);
      setStats((await whatsappService.identityStats()).data ?? null);
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Could not add the numbers'));
    } finally {
      setEnrolling(false);
    }
  }

  async function verifyPending() {
    setVerifying(true);
    try {
      const res = await whatsappService.verifyPending();
      toast.success(
        `Checked ${res.data?.checked ?? 0} number(s), ${res.data?.verified ?? 0} confirmed on WhatsApp`,
      );
      setStats((await whatsappService.identityStats()).data ?? null);
    } catch {
      toast.error('Could not check the numbers');
    } finally {
      setVerifying(false);
    }
  }

  async function retry(id: string) {
    try {
      await whatsappService.retry(id);
      toast.success('Trying again');
      void loadRecent();
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Could not try again'));
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-6 text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }
  if (!cfg) return <p className="p-6 text-slate-500">WhatsApp settings are unavailable.</p>;

  const enrollReady = enrollPreview
    ? enrollPreview.results.filter((r) => r.outcome !== 'skipped').length
    : 0;
  const enrollSkipped = enrollPreview
    ? enrollPreview.results.filter((r) => r.outcome === 'skipped').length
    : 0;

  const ready = Boolean(conn?.configured) && conn?.state === 'open';
  const needsSetup = conn ? !conn.configured : false;

  return (
    <div className="space-y-5">
      {/* Impossible to miss: while this is on, staff receive nothing.
          Guarded on the parsed state as well, because the field is now seeded
          with an UNPARSEABLE value too — and that one is not test mode, it is
          the outage below. */}
      {cfg.redirectAllTo && !cfg.redirectMisconfigured && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4">
          <FlaskConical className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <div className="text-sm text-amber-900">
            <p className="font-semibold">Test mode is on</p>
            <p className="mt-0.5">
              Every message is going to{' '}
              <span className="font-mono font-medium">{cfg.redirectAllTo}</span> instead of your
              team. Nobody else receives anything, and each message says who it was meant for.
              Clear the test recipient under Setup before going live.
            </p>
          </div>
        </div>
      )}

      {cfg.redirectMisconfigured && (
        <div className="flex items-start gap-3 rounded-xl border border-rose-300 bg-rose-50 p-4">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-600" />
          <div className="text-sm text-rose-900">
            <p className="font-semibold">Sending is stopped</p>
            <p className="mt-0.5">
              The test recipient{' '}
              {cfg.redirectAllToRaw && (
                <span className="font-mono font-medium">“{cfg.redirectAllToRaw}”</span>
              )}{' '}
              could not be read
              {cfg.defaultRegion ? ` as a phone number for ${cfg.defaultRegion}` : ''}, so nothing
              is being sent to anyone. Give it a country code, or clear it to start messaging your
              team again.
            </p>
            {/* The whole failure was that this had no one-click exit: the field
                rendered empty, so there was nothing visible to clear. */}
            <button
              type="button"
              onClick={clearRedirect}
              disabled={saving}
              className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-xs font-medium text-rose-800 hover:bg-rose-50 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Clear it and resume sending
            </button>
          </div>
        </div>
      )}

      {/* ============================================================ main */}
      <Card
        title="WhatsApp updates"
        subtitle="Send HR alerts to your team on WhatsApp, alongside email and in-app notifications."
        icon={<MessageCircle className="h-5 w-5" />}
      >
        <Toggle
          label="Send updates on WhatsApp"
          hint="When off, nothing is sent to anyone."
          checked={cfg.enabled}
          onChange={(v) => patch({ enabled: v })}
        />

        <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4">
          <ReadyPill conn={conn} />
          <button
            type="button"
            onClick={refreshConnection}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
          >
            <RefreshCw className="h-4 w-4" /> Check again
          </button>
          {conn?.configured && conn.state !== 'open' && (
            <button
              type="button"
              onClick={showQr}
              disabled={qrLoading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              {qrLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <QrCode className="h-4 w-4" />
              )}
              Link a phone
            </button>
          )}
        </div>

        {ready && !cfg.enabled && (
          <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            Everything is ready, but “Send updates on WhatsApp” is off, so nothing reaches your
            team. Switch it on above and save when you want to go live.
          </p>
        )}

        {needsSetup && (
          <p className="flex items-start gap-2 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
            <Settings2 className="mt-0.5 h-4 w-4 shrink-0" />
            Finish the one-time setup at the bottom of this page to get started.
          </p>
        )}

        {qr?.base64 && (
          <div className="flex flex-col items-start gap-2 border-t border-slate-100 pt-4">
            <p className="text-sm text-slate-600">
              On the phone that will send the messages, open WhatsApp → Linked devices → Link a
              device, then scan this:
            </p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={qr.base64.startsWith('data:') ? qr.base64 : `data:image/png;base64,${qr.base64}`}
              alt="Pairing code"
              className="h-56 w-56 rounded-lg border border-slate-200"
            />
            <p className="text-xs text-slate-400">
              The code expires after a minute or so — press “Link a phone” again if it stops working.
            </p>
          </div>
        )}
        {qr?.pairingCode && (
          <p className="text-sm text-slate-700">
            Pairing code: <span className="font-mono font-semibold">{qr.pairingCode}</span>
          </p>
        )}
      </Card>

      {/* ============================================================ test */}
      <Card
        title="Send a test message"
        subtitle="Check how an update looks before your team starts receiving them."
        icon={<Send className="h-5 w-5" />}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Send to" hint="Any WhatsApp number, including the country code.">
            <input
              className={inputCls}
              value={testPhone}
              onChange={(e) => setTestPhone(e.target.value)}
              placeholder="+968 9001 0000"
            />
          </Field>
          <Field label="Example update">
            <select
              className={inputCls}
              value={testTemplate}
              onChange={(e) => setTestTemplate(e.target.value)}
            >
              {templates.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => runTest(true)}
            disabled={testing}
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            Preview
          </button>
          <button
            type="button"
            onClick={() => runTest(false)}
            disabled={testing}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-primary px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Send test
          </button>
        </div>

        {testResult && (
          <div className="rounded-lg bg-slate-50 p-3">
            <p className="mb-2 text-xs text-slate-500">
              {testResult.redirected
                ? `Test mode — delivered to ${testResult.deliveredTo}, not ${testResult.phone}`
                : `To ${testResult.phone}`}
            </p>
            <pre className="whitespace-pre-wrap break-words font-sans text-sm text-slate-700">
              {testResult.body}
            </pre>
          </div>
        )}
      </Card>

      {/* ======================================================== two-way */}
      <Card
        title="Two-way HR services"
        subtitle="Let your team check balances, book leave and approve requests by messaging you."
        icon={<MessagesSquare className="h-5 w-5" />}
      >
        <div className="space-y-3">
          <Toggle
            label="Let staff message HR here"
            hint="Off means we only send. Anything incoming is ignored."
            checked={cfg.inboundEnabled}
            onChange={(v) => patch({ inboundEnabled: v })}
          />

          {cfg.inboundEnabled && !cfg.webhookSecretConfigured && (
            <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Two-way is on, but WhatsApp has not been told where to send messages, so nothing
                will arrive.{' '}
                <button
                  type="button"
                  onClick={() => setSetupOpen(true)}
                  className="font-medium underline underline-offset-2"
                >
                  Open Setup
                </button>{' '}
                and set the callback address under &ldquo;Where incoming messages arrive&rdquo;.
              </span>
            </p>
          )}

          <Toggle
            label="Let staff link their own number"
            hint="They confirm a code in the portal, so a stolen SIM alone cannot link a number."
            checked={cfg.enrollmentEnabled}
            onChange={(v) => patch({ enrollmentEnabled: v })}
          />
          <Toggle
            label="Allow requests and changes"
            hint="Off is a read-only pilot: staff can check balances but cannot submit anything."
            checked={cfg.mutationsEnabled}
            onChange={(v) => patch({ mutationsEnabled: v })}
          />
          <Toggle
            label="Allow approvals from WhatsApp"
            hint="Approvers get Approve and Reject buttons on the notification itself."
            checked={cfg.approvalsEnabled}
            onChange={(v) => patch({ approvalsEnabled: v })}
          />
          <Toggle
            label="Ask for a PIN before pay details"
            checked={cfg.requirePinForSensitive}
            onChange={(v) => patch({ requirePinForSensitive: v })}
          />
          {!cfg.requirePinForSensitive && (
            <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Payslips and loan balances will be shown to whoever is holding the phone.
            </p>
          )}

          {cfg.approvalsEnabled && (
            <Field
              label="Approve / Reject buttons stay usable for"
              hint="An approval that arrives in the evening should still be tappable the next morning."
            >
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={336}
                  className={`${inputCls} w-28`}
                  value={Math.round(cfg.approvalTokenTtlMinutes / 60)}
                  onChange={(e) =>
                    patch({ approvalTokenTtlMinutes: Math.max(1, Number(e.target.value)) * 60 })
                  }
                />
                <span className="text-sm text-slate-500">hours</span>
              </div>
            </Field>
          )}
        </div>
      </Card>

      {/* =================================================== verification */}
      <Card
        title="Attendance from WhatsApp"
        subtitle="What someone has to prove before a check-in from chat is accepted."
        icon={<ShieldCheck className="h-5 w-5" />}
      >
        <div className="space-y-4">
          <Field label="Proof required" hint="Only applies when your company requires face verification for attendance.">
            <select
              className={inputCls}
              value={cfg.attendanceVerification}
              onChange={(e) => patch({ attendanceVerification: e.target.value })}
            >
              <option value="OFF">Not allowed — attendance must be done in the app</option>
              <option value="IDENTITY_ONLY">The linked number is enough</option>
              <option value="SELFIE_IN_CHAT">A photo sent in the chat, matched to their face</option>
              <option value="SECURE_LINK">A one-time link with a live camera</option>
            </select>
          </Field>

          {cfg.attendanceVerification === 'SELFIE_IN_CHAT' && (
            <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
              The employee sends a photo in the chat and we match it against their registered
              face. This proves the photo is of them; it cannot prove they took it just now — a
              saved photo looks identical to us. Use the secure link if you need a live camera.
              We do reject a photo that has been used before, and cap how many photo check-ins
              one person can make per day.
            </p>
          )}

          {(cfg.attendanceVerification === 'SELFIE_IN_CHAT' ||
            cfg.attendanceVerification === 'SECURE_LINK') && (
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Photo check-ins per day">
                <input
                  type="number"
                  min={1}
                  max={50}
                  className={inputCls}
                  value={cfg.selfieDailyCap}
                  onChange={(e) => patch({ selfieDailyCap: Number(e.target.value) })}
                />
              </Field>
              <Field label="Photo must arrive within (seconds)">
                <input
                  type="number"
                  min={30}
                  max={900}
                  className={inputCls}
                  value={cfg.selfieChallengeSeconds}
                  onChange={(e) => patch({ selfieChallengeSeconds: Number(e.target.value) })}
                />
              </Field>
              <Field label="Link expires after (minutes)">
                <input
                  type="number"
                  min={2}
                  max={60}
                  className={inputCls}
                  value={cfg.verificationLinkTtlMinutes}
                  onChange={(e) => patch({ verificationLinkTtlMinutes: Number(e.target.value) })}
                />
              </Field>
            </div>
          )}
        </div>
      </Card>

      {/* ========================================================= actions */}
      <WhatsAppActionSwitches
        mutationsEnabled={cfg.mutationsEnabled}
        approvalsEnabled={cfg.approvalsEnabled}
        requirePinForSensitive={cfg.requirePinForSensitive}
      />

      {/* =========================================================== voice */}
      <Card
        title="Voice"
        subtitle="What the assistant says when it cannot help."
        icon={<Languages className="h-5 w-5" />}
      >
        <Field
          label="Who to contact when we cannot help"
          hint="Shown only after several unrecognised messages in a row, so it does not clutter normal replies."
        >
          <input
            className={inputCls}
            value={cfg.supportContact}
            onChange={(e) => patch({ supportContact: e.target.value })}
            placeholder="HR desk, +968 9000 0000"
          />
        </Field>
      </Card>

      {/* ================================================= phone & region */}
      <Card
        title="Phone & region"
        subtitle="Controls how phone numbers typed without a country code are understood."
        icon={<Languages className="h-5 w-5" />}
      >
        <Field
          label="Default country code"
          hint="Fallback for a number typed without a country prefix (e.g. 9001 0000). An employee's own phone country, then their branch's country, are used first — this only covers whoever has neither. Every number already stored with a + is unaffected."
        >
          <select
            id="wa-default-region"
            className={inputCls}
            value={cfg.defaultRegion}
            onChange={(e) => patch({ defaultRegion: e.target.value })}
          >
            <option value="">— not set —</option>
            <option value="IN">🇮🇳 India (+91)</option>
            <option value="AE">🇦🇪 United Arab Emirates (+971)</option>
            <option value="SA">🇸🇦 Saudi Arabia (+966)</option>
            <option value="OM">🇴🇲 Oman (+968)</option>
            <option value="QA">🇶🇦 Qatar (+974)</option>
            <option value="KW">🇰🇼 Kuwait (+965)</option>
            <option value="BH">🇧🇭 Bahrain (+973)</option>
            <option value="MY">🇲🇾 Malaysia (+60)</option>
            <option value="SG">🇸🇬 Singapore (+65)</option>
            <option value="PH">🇵🇭 Philippines (+63)</option>
            <option value="LK">🇱🇰 Sri Lanka (+94)</option>
            <option value="BD">🇧🇩 Bangladesh (+880)</option>
            <option value="PK">🇵🇰 Pakistan (+92)</option>
            <option value="NP">🇳🇵 Nepal (+977)</option>
            <option value="GB">🇬🇧 United Kingdom (+44)</option>
            <option value="US">🇺🇸 United States (+1)</option>
            <option value="AU">🇦🇺 Australia (+61)</option>
            <option value="CA">🇨🇦 Canada (+1)</option>
            <option value="ZA">🇿🇦 South Africa (+27)</option>
            <option value="NG">🇳🇬 Nigeria (+234)</option>
          </select>
        </Field>

        {cfg.defaultRegion && (
          <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
            Numbers without a country code (e.g. <span className="font-mono">8430 00000</span>)
            will be read as <span className="font-mono">+{REGION_DIAL[cfg.defaultRegion] ?? '?'}</span>.
            Numbers already entered with a{' '}<span className="font-mono">+</span> are always used as-is.
          </p>
        )}
      </Card>

      {/* ======================================================== coverage */}
      <Card
        title="Which updates go out"
        subtitle="Switch off anything your team should not get on WhatsApp. It still arrives by email and in the portal."
        icon={<CheckCircle2 className="h-5 w-5" />}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-slate-500">
            <span className="font-medium text-slate-700">{onCount}</span> of {selectable.length} on
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setAllUpdates(true)}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
            >
              Turn all on
            </button>
            <button
              type="button"
              onClick={() => setAllUpdates(false)}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
            >
              Turn all off
            </button>
          </div>
        </div>

        <div className="space-y-4">
          {groupedTemplates.map(([group, items]) => (
            <div key={group}>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
                {group}
              </p>
              <div className="divide-y divide-slate-50 rounded-lg border border-slate-100">
                {items.map((t) => (
                  <label
                    key={t.key}
                    className="flex cursor-pointer items-center justify-between gap-4 px-3 py-2.5 hover:bg-slate-50/60"
                  >
                    <span className="text-sm text-slate-700">
                      {t.label}
                      {t.requiresCatchAllSetting && (
                        <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-slate-500">
                          Not recommended
                        </span>
                      )}
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={isUpdateOn(t.key)}
                      aria-label={t.label}
                      onClick={() => toggleUpdate(t.key)}
                      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-brand-primary/30 ${
                        isUpdateOn(t.key) ? 'bg-brand-primary' : 'bg-slate-300'
                      }`}
                    >
                      <span
                        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-sm transition-transform duration-200 ${
                          isUpdateOn(t.key) ? 'translate-x-[1.15rem]' : 'translate-x-0.5'
                        }`}
                      />
                    </button>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>

        {onCount === 0 && (
          <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            Every update is switched off, so nobody will receive anything on WhatsApp.
          </p>
        )}
      </Card>

      {/* ====================================================== recipients */}
      <Card
        title="Who receives updates"
        subtitle="Your team is reached on the number already held on their HR record."
        icon={<Users className="h-5 w-5" />}
      >
        {/* The switch that makes "turn it on and staff get messages" true.
            Without it, `enabled` looked like the switch and delivered to nobody
            until each employee found an opt-in page they did not know about. */}
        <Toggle
          label="Message everyone who has a phone number on file"
          hint="Staff are reached on their HR phone number as soon as this and “Send updates on WhatsApp” are on. Anyone who has explicitly opted out is never messaged."
          checked={cfg.autoEnroll}
          onChange={(v) => patch({ autoEnroll: v })}
        />

        {!cfg.autoEnroll && (
          <p className="flex items-start gap-2 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
            <Settings2 className="mt-0.5 h-4 w-4 shrink-0" />
            With this off, each employee has to add their own number under Profile → WhatsApp
            updates before they receive anything.
          </p>
        )}

        {stats && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Numbers added" value={stats.total} />
            <Stat label="Agreed to updates" value={stats.optedIn} />
            <Stat label="Receiving updates" value={stats.deliverable} accent />
            <Stat label="Need attention" value={stats.suspended} />
          </div>
        )}

        {/* The gap that kept a working channel delivering to nobody: numbers were
            already on employee records and there was no way to use them. */}
        {stats?.deliverable === 0 && (
          <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {cfg.autoEnroll
              ? 'Nobody is receiving updates yet. Numbers are added automatically the first time an update goes out — use “Add my team’s numbers” to do it now and see which ones need fixing.'
              : 'Nobody is set up to receive anything, so no updates are going out. Switch on “Message everyone who has a phone number on file” above, or add the numbers below.'}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void previewEnroll()}
            disabled={enrolling}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            {enrolling ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Users className="h-4 w-4" />
            )}
            Add my team’s numbers
          </button>
          <button
            type="button"
            onClick={verifyPending}
            disabled={verifying}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            {verifying ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Check unconfirmed numbers
          </button>
        </div>

        {/* Always a preview first. Committing writes consent on the team's
            behalf, which is not something to discover after the fact. */}
        {enrollPreview && (
          <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/60 p-4">
            <p className="text-sm font-medium text-slate-700">
              {enrollReady} of {enrollPreview.considered} can be added
              {enrollSkipped > 0 ? `, ${enrollSkipped} need attention` : ''}
            </p>
            <ul className="max-h-56 space-y-1 overflow-y-auto text-xs">
              {enrollPreview.results.map((r) => (
                <li key={r.employeeId} className="flex items-start gap-2">
                  {r.outcome === 'skipped' ? (
                    <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-500" />
                  ) : (
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                  )}
                  <span className="text-slate-600">
                    <span className="font-medium text-slate-700">{r.name}</span>{' '}
                    <span className="font-mono">{r.phoneMasked}</span>
                    {r.reason ? ` — ${r.reason}` : ''}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-amber-800">
              Adding them records that <span className="font-medium">you</span> agreed on their
              behalf. Leave the box unticked to link the numbers without that, in which case each
              person still has to agree from their own profile before anything is sent.
            </p>
            <label className="flex items-center gap-2 text-xs text-slate-700">
              <input
                type="checkbox"
                checked={enrollConsent}
                onChange={(e) => setEnrollConsent(e.target.checked)}
              />
              I confirm my team agreed to receive HR updates on WhatsApp
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void commitEnroll()}
                disabled={enrolling || enrollReady === 0}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand-primary px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {enrolling ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Add {enrollReady} number{enrollReady === 1 ? '' : 's'}
              </button>
              <button
                type="button"
                onClick={() => setEnrollPreview(null)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </Card>

      {/* ========================================================== recent */}
      <Card
        title="Recent messages"
        subtitle="Phone numbers are partly hidden."
        icon={<Clock className="h-5 w-5" />}
      >
        {recentLoading ? (
          <p className="py-4 text-sm text-slate-400">Loading…</p>
        ) : recent.length === 0 ? (
          <p className="py-4 text-sm text-slate-400">No messages yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-xs uppercase text-slate-400">
                  <th className="py-2 pr-3 font-medium">When</th>
                  <th className="py-2 pr-3 font-medium">Update</th>
                  <th className="py-2 pr-3 font-medium">To</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {recent.map((r) => {
                  const s = DELIVERY_LABEL[r.status] ?? {
                    text: r.status,
                    cls: 'bg-slate-100 text-slate-600',
                  };
                  return (
                    <tr key={r.id}>
                      <td className="whitespace-nowrap py-2 pr-3 text-slate-500">
                        {formatWhen(r.createdAt)}
                      </td>
                      <td className="py-2 pr-3 text-slate-700">
                        {friendlyTemplate(r.templateKey, templates)}
                      </td>
                      <td className="py-2 pr-3 text-slate-600">{r.to}</td>
                      <td className="py-2 pr-3">
                        <span className={`rounded px-2 py-0.5 text-xs font-medium ${s.cls}`}>
                          {s.text}
                        </span>
                      </td>
                      <td className="py-2 text-right">
                        {(r.status === 'FAILED' || r.status === 'SKIPPED') && (
                          <button
                            type="button"
                            onClick={() => retry(r.id)}
                            className="text-xs font-medium text-brand-primary hover:underline"
                          >
                            Try again
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* =========================================================== setup */}
      <div className="rounded-xl border border-slate-200 bg-white">
        <button
          type="button"
          onClick={() => setSetupOpen((v) => !v)}
          className="flex w-full items-center justify-between gap-3 p-5 text-left"
        >
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
              <Settings2 className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-semibold text-slate-800">Setup</h3>
              <p className="text-sm text-slate-500">
                Set up once when WhatsApp is first switched on. You should not need to change this.
              </p>
            </div>
          </div>
          <ChevronDown
            className={`h-5 w-5 shrink-0 text-slate-400 transition-transform ${
              setupOpen ? 'rotate-180' : ''
            }`}
          />
        </button>

        {setupOpen && (
          <div className="space-y-4 border-t border-slate-100 p-5">
            <Field label="Service address">
              <input
                className={inputCls}
                value={cfg.baseUrl}
                onChange={(e) => patch({ baseUrl: e.target.value })}
                placeholder="https://…"
              />
            </Field>

            <Field label="Account name">
              <input
                className={inputCls}
                value={cfg.instanceName}
                onChange={(e) => patch({ instanceName: e.target.value })}
              />
            </Field>

            <Field
              label="Access key"
              hint="Stored securely and never shown again. Leave blank to keep the current one."
            >
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  autoComplete="new-password"
                  className={`${inputCls} flex-1`}
                  value={newApiKey}
                  disabled={clearKey}
                  onChange={(e) => setNewApiKey(e.target.value)}
                  placeholder={cfg.apiKeyConfigured ? '••••••••' : 'Not set'}
                />
                {cfg.apiKeyConfigured && (
                  <button
                    type="button"
                    onClick={() => {
                      setClearKey((v) => !v);
                      setNewApiKey('');
                    }}
                    className={`shrink-0 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                      clearKey
                        ? 'border-rose-300 bg-rose-50 text-rose-700'
                        : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {clearKey ? 'Will remove on save' : 'Remove'}
                  </button>
                )}
              </div>
            </Field>

            <div className="grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-2">
              <Field label="Portal address" hint="Used for the links inside messages.">
                <input
                  className={inputCls}
                  value={cfg.appBaseUrl}
                  onChange={(e) => patch({ appBaseUrl: e.target.value })}
                />
              </Field>
              <Field
                label="API address"
                hint="This system's own address, as the WhatsApp service can reach it. Usually not the portal address — the API answers on its own host."
              >
                <input
                  className={inputCls}
                  value={cfg.publicApiUrl}
                  onChange={(e) => patch({ publicApiUrl: e.target.value })}
                  placeholder="https://api.hrm.example.com"
                />
              </Field>
            </div>

            <WebhookPanel
              wh={webhook}
              typedBase={cfg.publicApiUrl}
              savedBase={webhook?.publicApiUrl ?? ''}
              loading={webhookLoading}
              onRefresh={loadWebhook}
            />

            <Field
              label="Test recipient"
              hint="For development only. While this has a number in it, every message goes there instead of to your team, and the opt-in checks are skipped. Leave empty in normal use."
            >
              <input
                className={inputCls}
                value={cfg.redirectAllTo}
                onChange={(e) => patch({ redirectAllTo: e.target.value })}
                placeholder="Empty — messages go to your team"
              />
            </Field>

            {/* Not the test recipient. That one TAKES delivery away from staff;
                this one leaves it alone and adds a watcher, so it is safe to
                leave on in production while a delivery fault is being chased. */}
            <div className="space-y-3 border-t border-slate-100 pt-4">
              <Toggle
                label="Send a copy to one number"
                hint="Your team still receives everything. One extra copy goes to the number below — including for people the system could not reach, which is how you tell “nothing arrived” from “nobody was ever addressed”."
                checked={cfg.carbonCopyEnabled}
                onChange={(v) => patch({ carbonCopyEnabled: v })}
              />
              {cfg.carbonCopyEnabled && (
                <Field label="Copy to" hint="Include the country code. Leave empty to stop copying.">
                  <input
                    className={inputCls}
                    value={cfg.carbonCopyTo}
                    onChange={(e) => patch({ carbonCopyTo: e.target.value })}
                    placeholder="Empty — no copies are sent"
                  />
                </Field>
              )}
              {cfg.carbonCopyMisconfigured && (
                <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  “{cfg.carbonCopyToRaw}” could not be read as a phone number, so no copies are
                  being sent. Your team is unaffected.
                </p>
              )}
            </div>

            {/* Ceilings, not rations. These exist to stop a stuck client
                looping, and staff should never meet them in normal use — the
                change ceiling used to be 5 per 10 minutes, which a single
                working day of punches exceeds on its own. */}
            <div className="space-y-3 border-t border-slate-100 pt-4">
              <p className="text-sm font-medium text-slate-700">Usage ceilings</p>
              <p className="text-xs text-slate-500">
                Safety limits against a looping client, not a quota on your team. Set any of
                them to <span className="font-mono">0</span> for no limit. Staff should never
                reach these in normal use — if they do, raise the number.
              </p>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Changes per 10 min" hint="Per employee. 0 = no limit.">
                  <input
                    type="number"
                    min={0}
                    className={inputCls}
                    value={cfg.rateMutations10Min}
                    onChange={(e) => patch({ rateMutations10Min: Number(e.target.value) })}
                  />
                </Field>
                <Field label="Messages per hour" hint="Per employee. 0 = no limit.">
                  <input
                    type="number"
                    min={0}
                    className={inputCls}
                    value={cfg.ratePerUserHour}
                    onChange={(e) => patch({ ratePerUserHour: Number(e.target.value) })}
                  />
                </Field>
                <Field label="Messages per 5 min" hint="Per phone, before we know who they are.">
                  <input
                    type="number"
                    min={0}
                    className={inputCls}
                    value={cfg.ratePerPhone5Min}
                    onChange={(e) => patch({ ratePerPhone5Min: Number(e.target.value) })}
                  />
                </Field>
              </div>
              {cfg.ratePerPhone5Min === 0 && (
                <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-2.5 text-xs text-amber-800">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  With no per-phone limit, an unknown number can send as fast as it likes. This
                  one runs before we know who the sender is, so it is the only flood protection
                  the channel has.
                </p>
              )}
            </div>

            <Field
              label="How menus look"
              hint="Tappable menus need a WhatsApp Business account. A poll is a normal WhatsApp poll and renders everywhere, at the cost of remembering only the option's wording."
            >
              <select
                className={inputCls}
                value={cfg.interactiveMode}
                onChange={(e) => patch({ interactiveMode: e.target.value })}
              >
                <option value="auto">Tappable menu (recommended)</option>
                <option value="buttons">Buttons only, menus as numbered text</option>
                <option value="poll">Tappable poll</option>
                <option value="text">Numbered text only</option>
              </select>
            </Field>

            <div className="space-y-3 border-t border-slate-100 pt-4">
              <Toggle
                label="Practice mode"
                hint="Prepare messages exactly as normal but do not actually send them."
                checked={cfg.dryRun}
                onChange={(v) => patch({ dryRun: v })}
              />
              <Toggle
                label="Only message people who agreed"
                hint="Strongly recommended. Turning this off messages anyone with a number on file."
                checked={cfg.requireOptIn}
                onChange={(v) => patch({ requireOptIn: v })}
              />
              <Toggle
                label="Only message confirmed numbers"
                checked={cfg.requireVerified}
                onChange={(v) => patch({ requireVerified: v })}
              />
              <Toggle
                label="Also send every other notification"
                hint="Not recommended — this forwards all portal notifications, which quickly becomes noisy."
                checked={cfg.allowGenericFallback}
                onChange={(v) => patch({ allowGenericFallback: v })}
              />
            </div>
          </div>
        )}
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-lg bg-brand-primary px-4 py-2.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save
        </button>
      </div>
    </div>
  );
}

/** One pill that answers "can we send right now?" without exposing plumbing. */
function ReadyPill({ conn }: { conn: WhatsAppConnection | null }) {
  if (!conn) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-600">
        <Loader2 className="h-4 w-4 animate-spin" /> Checking…
      </span>
    );
  }
  if (!conn.configured) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-600">
        <Settings2 className="h-4 w-4" /> Setup not finished
      </span>
    );
  }
  const map: Record<string, { cls: string; icon: ReactNode; text: string }> = {
    open: {
      cls: 'bg-emerald-50 text-emerald-700',
      icon: <CheckCircle2 className="h-4 w-4" />,
      text: 'Ready to send',
    },
    connecting: {
      cls: 'bg-amber-50 text-amber-700',
      icon: <Loader2 className="h-4 w-4 animate-spin" />,
      text: 'Connecting',
    },
    close: {
      cls: 'bg-rose-50 text-rose-700',
      icon: <XCircle className="h-4 w-4" />,
      text: 'Phone not linked',
    },
    unknown: {
      cls: 'bg-slate-100 text-slate-600',
      icon: <AlertTriangle className="h-4 w-4" />,
      text: 'Cannot reach WhatsApp',
    },
  };
  const s = map[conn.state] ?? map.unknown;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm ${s.cls}`}>
      {s.icon} {s.text}
    </span>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className={`rounded-lg p-3 ${accent ? 'bg-brand-primary/10' : 'bg-slate-50'}`}>
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`text-lg font-semibold ${accent ? 'text-brand-primary' : 'text-slate-800'}`}>
        {value}
      </p>
    </div>
  );
}

/** Map an internal template key back to the name shown everywhere else. */
function friendlyTemplate(key: string, templates: WhatsAppTemplate[]): string {
  // Admin test sends are logged as `test:<key>`; the example used is noise here.
  if (key.startsWith('test:')) return 'Test message';
  const match = templates.find((t) => t.key === key);
  return match?.label ?? key.replace(/_/g, ' ');
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const mins = Math.round((Date.now() - d.getTime()) / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)} h ago`;
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
}

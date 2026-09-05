'use client';

import { ReactNode, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Search,
  Server,
  Sparkles,
  Trash2,
  X,
  XCircle,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import copilotSettingsService from '@/services/copilotSettingsService';
import {
  CopilotSettings,
  TestConnectionResult,
  UpdateCopilotSettings,
} from '@/types/copilotSettings';

// ---- local styled primitives (Settings page keeps these inline; kept local here) ----
function Card({ title, subtitle, icon, children }: { title: string; subtitle?: string; icon: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="mb-4 flex items-start gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-primary/10 text-brand-primary">{icon}</div>
        <div>
          <h3 className="font-semibold text-slate-800">{title}</h3>
          {subtitle && <p className="text-sm text-slate-500">{subtitle}</p>}
        </div>
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
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
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-brand-primary/30 ${checked ? 'bg-brand-primary' : 'bg-slate-300'}`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform duration-200 ${checked ? 'translate-x-6' : 'translate-x-1'}`}
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

const inputCls =
  'w-full h-10 px-3 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/30 transition-all';

export default function CopilotSettingsSection() {
  const [cfg, setCfg] = useState<CopilotSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelsSource, setModelsSource] = useState<'live' | 'fallback' | null>(null);
  const [modelsMessage, setModelsMessage] = useState<string | undefined>();
  const [loadingModels, setLoadingModels] = useState(false);

  // API-key input state (separate from cfg — never round-trips the real key)
  const [newApiKey, setNewApiKey] = useState('');
  const [clearApiKey, setClearApiKey] = useState(false);
  const [newModel, setNewModel] = useState('');
  const [modelSearch, setModelSearch] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null);

  useEffect(() => {
    copilotSettingsService
      .getSettings()
      .then((res) => {
        setCfg(res.data);
        // Load the model list for the endpoint that's actually configured.
        void loadModels(res.data.llmBaseUrl);
      })
      .catch((e: any) => toast.error(e?.response?.data?.message || 'Failed to load copilot settings'))
      .finally(() => setLoading(false));
  }, []);

  // Reload models against the current (possibly-unsaved) Base URL + typed key.
  const loadModels = async (baseUrl?: string) => {
    setLoadingModels(true);
    try {
      const res = await copilotSettingsService.getAvailableModels({
        baseUrl: baseUrl ?? cfg?.llmBaseUrl,
        apiKey: newApiKey.trim() || undefined,
      });
      setAvailableModels(res.data.models);
      setModelsSource(res.data.source);
      setModelsMessage(res.data.message);
    } catch {
      // non-fatal — chips still editable via free-add
    } finally {
      setLoadingModels(false);
    }
  };

  const patch = (p: Partial<CopilotSettings>) => setCfg((c) => (c ? { ...c, ...p } : c));

  const toggleModel = (m: string) => {
    if (!cfg) return;
    const has = cfg.models.includes(m);
    patch({ models: has ? cfg.models.filter((x) => x !== m) : [...cfg.models, m] });
  };

  const addModel = () => {
    const m = newModel.trim();
    if (!cfg || !m || cfg.models.includes(m)) return;
    patch({ models: [...cfg.models, m] });
    setNewModel('');
  };

  const handleTest = async () => {
    if (!cfg) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await copilotSettingsService.testConnection({
        baseUrl: cfg.llmBaseUrl,
        apiKey: newApiKey.trim() || undefined, // typed new key wins; else server uses the stored one
        model: cfg.modelOverride.trim() || cfg.models[0],
      });
      setTestResult(res.data);
    } catch (e: any) {
      setTestResult({ ok: false, message: e?.response?.data?.message || e?.message || 'Test failed' });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!cfg) return;
    setSaving(true);
    try {
      const dto: UpdateCopilotSettings = {
        mcpEnabled: cfg.mcpEnabled,
        mcpAuditReads: cfg.mcpAuditReads,
        mcpMaxItems: cfg.mcpMaxItems,
        mcpLoopbackUrl: cfg.mcpLoopbackUrl,
        copilotEnabled: cfg.copilotEnabled,
        llmBaseUrl: cfg.llmBaseUrl,
        models: cfg.models,
        modelOverride: cfg.modelOverride,
        maxIterations: cfg.maxIterations,
        pendingTtlMinutes: cfg.pendingTtlMinutes,
        rateLimit: cfg.rateLimit,
        rateWindowMs: cfg.rateWindowMs,
      };
      if (clearApiKey) dto.clearApiKey = true;
      else if (newApiKey.trim()) dto.llmApiKey = newApiKey.trim();

      const res = await copilotSettingsService.update(dto);
      setCfg(res.data);
      setNewApiKey('');
      setClearApiKey(false);
      toast.success('HR Copilot settings saved successfully!');
    } catch (e: any) {
      toast.error(e?.response?.data?.message || e?.message || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  if (loading || !cfg) {
    return (
      <div className="flex items-center gap-2 py-16 text-slate-400">
        <Loader2 size={16} className="animate-spin" /> Loading HR Copilot settings…
      </div>
    );
  }

  const numberField = (
    label: string,
    key: keyof CopilotSettings,
    hint?: string,
    min = 1,
  ) => (
    <Field label={label} hint={hint}>
      <input
        type="number"
        min={min}
        value={cfg[key] as number}
        onChange={(e) => patch({ [key]: Number(e.target.value) } as Partial<CopilotSettings>)}
        className={inputCls}
      />
    </Field>
  );

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-primary/10 text-brand-primary">
          <Sparkles size={20} />
        </div>
        <div>
          <h2 className="text-lg font-bold text-slate-900">HR Copilot</h2>
          <p className="text-sm text-slate-500">Configure the MCP server and the AI copilot. Changes apply within ~30s (no redeploy).</p>
        </div>
      </div>

      <Card title="MCP Server" subtitle="Tool endpoint used by the copilot and external MCP clients" icon={<Server size={18} />}>
        <Toggle label="MCP enabled" hint="Turn the /mcp tool endpoint on or off" checked={cfg.mcpEnabled} onChange={(v) => patch({ mcpEnabled: v })} />
        <Toggle label="Audit read-only calls" hint="Log every read tool call (not just writes)" checked={cfg.mcpAuditReads} onChange={(v) => patch({ mcpAuditReads: v })} />
        <div className="grid gap-4 sm:grid-cols-2">
          {numberField('Max list items', 'mcpMaxItems', 'Default trim size for tool results')}
          <Field label="Loopback URL" hint="Blank = auto from server port">
            <input value={cfg.mcpLoopbackUrl} onChange={(e) => patch({ mcpLoopbackUrl: e.target.value })} placeholder="http://127.0.0.1:3001/mcp" className={inputCls} />
          </Field>
        </div>
      </Card>

      <Card title="LLM Endpoint" subtitle="Any OpenAI-compatible /chat/completions API" icon={<Bot size={18} />}>
        <Toggle label="Copilot enabled" hint="PII kill switch — disables /copilot/*" checked={cfg.copilotEnabled} onChange={(v) => patch({ copilotEnabled: v })} />
        <Field label="Base URL" hint="e.g. https://openrouter.ai/api/v1 or https://api.openai.com/v1 — the model list below reloads for this endpoint">
          <input
            value={cfg.llmBaseUrl}
            onChange={(e) => patch({ llmBaseUrl: e.target.value })}
            onBlur={() => loadModels()}
            placeholder="https://openrouter.ai/api/v1"
            className={inputCls}
          />
        </Field>

        <Field label="API Key" hint={cfg.llmApiKeyConfigured ? `Currently set: ${cfg.llmApiKeyMasked} — stored encrypted. Enter a new value to replace.` : 'Not set — stored encrypted at rest.'}>
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <KeyRound size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="password"
                value={newApiKey}
                disabled={clearApiKey}
                onChange={(e) => setNewApiKey(e.target.value)}
                placeholder={cfg.llmApiKeyConfigured ? '•••••••• (unchanged)' : 'sk-...'}
                className={`${inputCls} pl-9 disabled:bg-slate-50`}
              />
            </div>
            {cfg.llmApiKeyConfigured && (
              <button
                type="button"
                onClick={() => { setClearApiKey((c) => !c); setNewApiKey(''); }}
                className={`inline-flex h-10 items-center gap-1.5 rounded-lg border px-3 text-sm ${clearApiKey ? 'border-red-300 bg-red-50 text-red-700' : 'border-slate-300 text-slate-600 hover:bg-slate-50'}`}
              >
                <Trash2 size={14} /> {clearApiKey ? 'Will remove' : 'Remove'}
              </button>
            )}
          </div>
        </Field>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleTest}
            disabled={testing}
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-brand-primary/40 bg-brand-primary/5 px-4 text-sm font-medium text-brand-primary hover:bg-brand-primary/10 disabled:opacity-50"
          >
            {testing ? <Loader2 size={15} className="animate-spin" /> : <Zap size={15} />}
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          <span className="text-xs text-slate-400">
            Tests the current Base URL, key {newApiKey.trim() ? '(new)' : '(saved)'} and top model — no save needed.
          </span>
        </div>

        {testResult && (
          <div
            className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm ${
              !testResult.ok
                ? 'border-red-200 bg-red-50 text-red-700'
                : testResult.toolCalling === false
                ? 'border-amber-200 bg-amber-50 text-amber-800'
                : 'border-green-200 bg-green-50 text-green-700'
            }`}
          >
            {!testResult.ok ? (
              <XCircle size={16} className="mt-0.5 shrink-0" />
            ) : testResult.toolCalling === false ? (
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            ) : (
              <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
            )}
            <div>
              <p>{testResult.message}</p>
              {typeof testResult.latencyMs === 'number' && (
                <p className="mt-0.5 text-xs opacity-70">Round-trip {testResult.latencyMs} ms</p>
              )}
            </div>
          </div>
        )}
      </Card>

      <Card title="Models" subtitle="Fallback chain tried in order; the override wins when set" icon={<Sparkles size={18} />}>
        <Field label="Fallback models (selected are tried top-to-bottom)">
          <div className="mb-2 flex flex-wrap gap-2">
            {cfg.models.map((m) => (
              <span key={m} className="inline-flex items-center gap-1 rounded-lg border border-brand-primary bg-brand-primary/10 px-2.5 py-1 text-xs font-medium text-brand-primary">
                {m}
                <button type="button" onClick={() => toggleModel(m)} aria-label={`remove ${m}`}><X size={12} /></button>
              </span>
            ))}
            {cfg.models.length === 0 && <span className="text-xs text-slate-400">None selected — the copilot cannot run.</span>}
          </div>

          <div className="mb-3 flex items-center gap-2">
            <input value={newModel} onChange={(e) => setNewModel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addModel())} placeholder="Add a model id…" className={inputCls} />
            <button type="button" onClick={addModel} className="inline-flex h-10 items-center gap-1 rounded-lg border border-slate-300 px-3 text-sm text-slate-600 hover:bg-slate-50"><Plus size={14} /> Add</button>
          </div>

          <div className="rounded-lg border border-slate-100 bg-slate-50/60 p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-medium text-slate-500">
                Tool-capable models {modelsSource === 'live' ? '(live from endpoint)' : modelsSource === 'fallback' ? '(suggested)' : ''}
              </p>
              <button type="button" onClick={() => loadModels()} className="inline-flex items-center gap-1 text-xs text-brand-primary hover:underline">
                {loadingModels ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Refresh
              </button>
            </div>
            {modelsSource === 'fallback' && modelsMessage && (
              <p className="mb-2 text-xs text-amber-600">{modelsMessage}</p>
            )}

            {(() => {
              const CAP = 18;
              const q = modelSearch.trim().toLowerCase();
              const matches = q ? availableModels.filter((m) => m.toLowerCase().includes(q)) : availableModels;
              const shown = matches.slice(0, CAP);
              return (
                <>
                  <div className="relative mb-2">
                    <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input
                      value={modelSearch}
                      onChange={(e) => setModelSearch(e.target.value)}
                      placeholder={`Search ${availableModels.length} models…`}
                      className={`${inputCls} h-9 pl-8`}
                    />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {shown.map((m) => {
                      const on = cfg.models.includes(m);
                      return (
                        <button
                          key={m}
                          type="button"
                          onClick={() => toggleModel(m)}
                          className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition-all ${on ? 'border-brand-primary bg-brand-primary/10 text-brand-primary' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'}`}
                        >
                          {m}
                        </button>
                      );
                    })}
                    {!availableModels.length && !loadingModels && (
                      <span className="text-xs text-slate-400">No models available — add one above.</span>
                    )}
                    {!!availableModels.length && !shown.length && (
                      <span className="text-xs text-slate-400">No match for “{modelSearch}”.</span>
                    )}
                  </div>
                  {matches.length > shown.length && (
                    <p className="mt-2 text-xs text-slate-400">
                      Showing {shown.length} of {matches.length}
                      {q ? ' matches' : ` — search to find the rest`}.
                    </p>
                  )}
                </>
              );
            })()}
          </div>
        </Field>

        <Field label="Model override" hint="Single model that bypasses the fallback chain — e.g. openai/gpt-4o-mini. Leave blank to use the chain.">
          <input value={cfg.modelOverride} onChange={(e) => patch({ modelOverride: e.target.value })} placeholder="(none)" className={inputCls} />
        </Field>
      </Card>

      <Card title="Agent limits" subtitle="Safety and rate controls" icon={<Server size={18} />}>
        <div className="grid gap-4 sm:grid-cols-2">
          {numberField('Max tool iterations / turn', 'maxIterations')}
          {numberField('Pending action TTL (minutes)', 'pendingTtlMinutes')}
          {numberField('Rate limit (requests / window / user)', 'rateLimit')}
          {numberField('Rate window (ms)', 'rateWindowMs', undefined, 1000)}
        </div>
      </Card>

      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={saving}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-brand-primary px-4 text-sm font-medium text-white transition-colors hover:bg-brand-primary-dark disabled:opacity-50"
        >
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}

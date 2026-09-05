'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Loader2, Plus, Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import wpsService, {
  WpsConfig,
  WpsConfigField,
  WpsEmployerProfile,
  WpsFormatInfo,
} from '@/services/wpsService';
import branchService from '@/services/branchService';
import { apiErrorMessage } from '@/utils/apiError';

const SECRET_MASK = '••••••••';

/**
 * Renders one field from a format's declared schema.
 *
 * This component has NO country or format knowledge — it switches on `type` only.
 * That is what makes adding a country zero frontend work: the new adapter declares
 * its fields and they appear here.
 */
function Field({
  field,
  value,
  onChange,
}: {
  field: WpsConfigField;
  value: string;
  onChange: (v: string) => void;
}) {
  const common =
    'h-9 w-full rounded-lg border border-slate-200 px-3 text-sm focus:border-brand-primary focus:outline-none';

  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-600">
        {field.label}
        {field.required && <span className="text-red-500"> *</span>}
      </span>

      {field.type === 'boolean' ? (
        <input
          type="checkbox"
          checked={value === 'true'}
          onChange={(e) => onChange(e.target.checked ? 'true' : 'false')}
          className="h-4 w-4"
        />
      ) : field.type === 'select' ? (
        <select value={value} onChange={(e) => onChange(e.target.value)} className={common}>
          <option value="">Select…</option>
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={field.secret ? 'password' : field.type === 'number' ? 'number' : 'text'}
          value={value}
          placeholder={field.placeholder ?? ''}
          onChange={(e) => onChange(e.target.value)}
          className={common}
        />
      )}

      {field.help && <span className="mt-1 block text-xs text-slate-400">{field.help}</span>}
    </label>
  );
}

export default function WpsSection() {
  const [formats, setFormats] = useState<WpsFormatInfo[]>([]);
  const [profiles, setProfiles] = useState<WpsEmployerProfile[]>([]);
  const [configs, setConfigs] = useState<WpsConfig[]>([]);
  const [branches, setBranches] = useState<{ id: string; code: string; name: string; country?: string | null }[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  // New-profile form
  const [showNew, setShowNew] = useState(false);
  const [newFormat, setNewFormat] = useState('');
  const [newName, setNewName] = useState('');
  const [newLegal, setNewLegal] = useState('');
  const [newValues, setNewValues] = useState<Record<string, string>>({});

  // Per-branch config draft
  const [draft, setDraft] = useState<Record<string, { profileId: string; format: string; enabled: boolean }>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [f, p, c, b] = await Promise.all([
        wpsService.formats(),
        wpsService.profiles(),
        wpsService.configs(),
        branchService.getAll(),
      ]);
      setFormats(f.data ?? []);
      setProfiles(p.data ?? []);
      setConfigs(c.data ?? []);
      setBranches((b as any).data ?? []);
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Failed to load WPS settings'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const newFormatInfo = useMemo(
    () => formats.find((f) => f.key === newFormat),
    [formats, newFormat],
  );

  const createProfile = async () => {
    if (!newFormatInfo) return toast.warning('Pick a format');
    if (!newName.trim() || !newLegal.trim()) return toast.warning('Name and legal name are required');
    const missing = newFormatInfo.employerConfigSchema
      .filter((f) => f.required && !newValues[f.name]?.trim())
      .map((f) => f.label);
    if (missing.length) return toast.warning(`Required: ${missing.join(', ')}`);

    setBusy('new-profile');
    try {
      await wpsService.createProfile({
        name: newName,
        legalName: newLegal,
        country: newFormatInfo.country === '*' ? 'OM' : newFormatInfo.country,
        format: newFormat,
        data: newValues,
      });
      toast.success('Employer profile created');
      setShowNew(false);
      setNewName('');
      setNewLegal('');
      setNewValues({});
      setNewFormat('');
      await load();
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Could not create the profile'));
    } finally {
      setBusy(null);
    }
  };

  const saveProfileData = async (profile: WpsEmployerProfile, values: Record<string, string>) => {
    setBusy(`profile-${profile.id}`);
    try {
      // Secret fields left at the mask are omitted, so the stored value survives.
      const schema = formats.find((f) => f.key === profile.format)?.employerConfigSchema ?? [];
      const payload: Record<string, unknown> = {};
      for (const f of schema) {
        const v = values[f.name];
        if (f.secret && (v === undefined || v === SECRET_MASK)) continue;
        payload[f.name] = v ?? '';
      }
      await wpsService.updateProfile(profile.id, { data: payload });
      toast.success('Employer details saved');
      await load();
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Could not save'));
    } finally {
      setBusy(null);
    }
  };

  const saveConfig = async (branchId: string) => {
    const d = draft[branchId];
    if (!d?.profileId || !d?.format) return toast.warning('Pick a format and an employer profile');
    setBusy(`config-${branchId}`);
    try {
      await wpsService.saveConfig({
        branchId,
        employerProfileId: d.profileId,
        format: d.format,
        enabled: d.enabled,
      });
      toast.success('Branch configuration saved');
      await load();
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Could not save the configuration'));
    } finally {
      setBusy(null);
    }
  };

  const removeConfig = async (id: string) => {
    if (!window.confirm('Remove WPS configuration for this branch?')) return;
    setBusy(`rm-${id}`);
    try {
      await wpsService.deleteConfig(id);
      toast.success('Configuration removed');
      await load();
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Could not remove it'));
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-6 text-slate-500">
        <Loader2 className="h-5 w-5 animate-spin" /> Loading WPS settings…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-900">Salary Payment Files (WPS)</h2>
        <p className="mt-1 text-sm text-slate-500">
          The wage file your bank requires each month. Configure the employer
          registration once, then point each branch at it. Generation happens from a
          locked payroll, under Payroll → open a run → Salary payment file.
        </p>
      </div>

      {/* ── Formats available ─────────────────────────────────────────── */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="mb-3 font-semibold text-slate-800">Installed formats</h3>
        <div className="space-y-2">
          {formats.map((f) => (
            <div key={f.key} className="rounded-lg border border-slate-100 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-slate-800">{f.displayName}</span>
                <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-600">
                  {f.key}
                </span>
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                  {f.country === '*' ? 'any country' : f.country}
                </span>
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                  {f.currency} · {f.currencyExponent} decimals
                </span>
              </div>
              <p className="mt-1 text-sm text-slate-500">{f.description}</p>
              <p className="mt-1 font-mono text-[11px] text-slate-400">spec {f.specVersion}</p>
              {f.specVersion.includes('PROVISIONAL') && (
                <p className="mt-2 flex items-start gap-1.5 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                  The exact layout is provisional. Confirm it against your bank&apos;s
                  current specification and test portal before submitting a real payroll.
                </p>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ── Employer profiles ─────────────────────────────────────────── */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-slate-800">Employer registration</h3>
            <p className="text-xs text-slate-500">
              Shared across branches — one Ministry establishment can cover several offices.
            </p>
          </div>
          <button
            onClick={() => setShowNew((v) => !v)}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <Plus size={14} /> New profile
          </button>
        </div>

        {showNew && (
          <div className="mb-4 rounded-lg border border-dashed border-slate-300 p-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-600">Format *</span>
                <select
                  value={newFormat}
                  onChange={(e) => {
                    setNewFormat(e.target.value);
                    setNewValues({});
                  }}
                  className="h-9 w-full rounded-lg border border-slate-200 px-3 text-sm"
                >
                  <option value="">Select a format…</option>
                  {formats.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-600">Label *</span>
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. Muscat establishment"
                  className="h-9 w-full rounded-lg border border-slate-200 px-3 text-sm"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-600">Legal name *</span>
                <input
                  value={newLegal}
                  onChange={(e) => setNewLegal(e.target.value)}
                  placeholder="Registered entity name"
                  className="h-9 w-full rounded-lg border border-slate-200 px-3 text-sm"
                />
              </label>
            </div>

            {newFormatInfo && (
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {newFormatInfo.employerConfigSchema.map((f) => (
                  <Field
                    key={f.name}
                    field={f}
                    value={newValues[f.name] ?? String(f.default ?? '')}
                    onChange={(v) => setNewValues((prev) => ({ ...prev, [f.name]: v }))}
                  />
                ))}
              </div>
            )}

            <div className="mt-3 flex justify-end">
              <button
                onClick={createProfile}
                disabled={busy === 'new-profile'}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand-primary px-3 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {busy === 'new-profile' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Check size={14} />
                )}
                Create
              </button>
            </div>
          </div>
        )}

        {profiles.length === 0 ? (
          <p className="text-sm text-slate-400">No employer profiles yet.</p>
        ) : (
          <div className="space-y-3">
            {profiles.map((p) => (
              <ProfileCard
                key={p.id}
                profile={p}
                schema={formats.find((f) => f.key === p.format)?.employerConfigSchema ?? []}
                busy={busy === `profile-${p.id}`}
                onSave={(values) => saveProfileData(p, values)}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Per-branch configuration ──────────────────────────────────── */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="mb-1 font-semibold text-slate-800">Branch configuration</h3>
        <p className="mb-3 text-xs text-slate-500">
          A format only appears for a branch whose country it applies to. Nothing
          generates until a branch is enabled.
        </p>

        <div className="space-y-2">
          {branches.map((b) => {
            const existing = configs.find((c) => c.branchId === b.id);
            const country = (b.country ?? '').toUpperCase();
            const eligible = formats.filter(
              (f) => f.country === '*' || f.country === country,
            );
            const d =
              draft[b.id] ??
              {
                profileId: existing?.employerProfile?.id ?? '',
                format: existing?.format ?? '',
                enabled: existing?.enabled ?? false,
              };
            const setD = (patch: Partial<typeof d>) =>
              setDraft((prev) => ({ ...prev, [b.id]: { ...d, ...patch } }));
            const profilesForFormat = profiles.filter(
              (p) => p.format === d.format && p.isActive,
            );

            return (
              <div key={b.id} className="rounded-lg border border-slate-100 p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="font-medium text-slate-800">{b.name}</span>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-600">
                    {b.code}
                  </span>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                    {country || 'no country set'}
                  </span>
                  {existing && (
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                        existing.enabled
                          ? 'bg-green-50 text-green-700'
                          : 'bg-slate-100 text-slate-500'
                      }`}
                    >
                      {existing.enabled ? 'ENABLED' : 'DISABLED'}
                    </span>
                  )}
                </div>

                {eligible.length === 0 ? (
                  <p className="text-sm text-amber-600">
                    No format applies to {country || 'a branch with no country'}. Set the
                    branch country under Organization → Branches.
                  </p>
                ) : (
                  <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-4">
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-slate-600">Format</span>
                      <select
                        value={d.format}
                        onChange={(e) => setD({ format: e.target.value, profileId: '' })}
                        className="h-9 w-full rounded-lg border border-slate-200 px-2 text-sm"
                      >
                        <option value="">Select…</option>
                        {eligible.map((f) => (
                          <option key={f.key} value={f.key}>
                            {f.displayName}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-slate-600">
                        Employer profile
                      </span>
                      <select
                        value={d.profileId}
                        onChange={(e) => setD({ profileId: e.target.value })}
                        disabled={!d.format}
                        className="h-9 w-full rounded-lg border border-slate-200 px-2 text-sm disabled:bg-slate-50"
                      >
                        <option value="">
                          {d.format ? 'Select…' : 'Pick a format first'}
                        </option>
                        {profilesForFormat.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="flex items-center gap-2 pb-1 text-sm text-slate-700">
                      <input
                        type="checkbox"
                        checked={d.enabled}
                        onChange={(e) => setD({ enabled: e.target.checked })}
                        className="h-4 w-4"
                      />
                      Enabled
                    </label>

                    <div className="flex gap-2">
                      <button
                        onClick={() => saveConfig(b.id)}
                        disabled={busy === `config-${b.id}`}
                        className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-brand-primary px-3 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                      >
                        {busy === `config-${b.id}` ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Save size={14} />
                        )}
                        Save
                      </button>
                      {existing && (
                        <button
                          onClick={() => removeConfig(existing.id)}
                          className="inline-flex h-9 items-center rounded-lg border border-red-200 px-2 text-red-600 hover:bg-red-50"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {d.format && profilesForFormat.length === 0 && (
                  <p className="mt-2 text-xs text-amber-600">
                    No employer profile exists for that format yet — create one above.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** One employer profile, its fields rendered from the format's declared schema. */
function ProfileCard({
  profile,
  schema,
  busy,
  onSave,
}: {
  profile: WpsEmployerProfile;
  schema: WpsConfigField[];
  busy: boolean;
  onSave: (values: Record<string, string>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    const seeded: Record<string, string> = {};
    for (const f of schema) {
      seeded[f.name] = profile.data?.[f.name] ?? String(f.default ?? '');
    }
    setValues(seeded);
  }, [profile, schema]);

  return (
    <div className="rounded-lg border border-slate-100 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-medium text-slate-800">{profile.name}</span>
        <span className="text-xs text-slate-500">{profile.legalName}</span>
        <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-600">
          {profile.format}
        </span>
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
          {profile.country}
        </span>
        {profile.usedByBranchIds.length > 0 && (
          <span className="text-xs text-slate-400">
            used by {profile.usedByBranchIds.length} branch(es)
          </span>
        )}
      </div>

      {schema.length === 0 ? (
        <p className="text-sm text-amber-600">
          Format {profile.format} is not installed in this build, so its fields cannot be edited.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {schema.map((f) => (
              <Field
                key={f.name}
                field={f}
                value={values[f.name] ?? ''}
                onChange={(v) => setValues((prev) => ({ ...prev, [f.name]: v }))}
              />
            ))}
          </div>
          <div className="mt-3 flex justify-end">
            <button
              onClick={() => onSave(values)}
              disabled={busy}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save size={14} />}
              Save employer details
            </button>
          </div>
        </>
      )}
    </div>
  );
}

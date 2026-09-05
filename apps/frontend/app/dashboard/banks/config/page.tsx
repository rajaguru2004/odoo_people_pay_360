'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Loader2, Trash2, Sparkles, X } from 'lucide-react';
import { toast } from 'sonner';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import PageActionRow from '@/components/common/PageActionRow';
import { COUNTRIES } from '@/lib/countries';
import { usePageHeader } from '@/hooks/usePageHeader';
import { apiErrorMessage } from '@/utils/apiError';
import bankingConfigService, {
  BankingFieldRow,
  FIELD_TYPES,
  UpsertBankingFieldData,
  VALIDATION_TYPES,
} from '@/services/bankingConfigService';

const EMPTY: UpsertBankingFieldData = {
  country: 'OM',
  fieldKey: '',
  label: '',
  fieldType: 'TEXT',
  validationType: 'NONE',
  required: true,
  displayOrder: 0,
  placeholder: '',
  helpText: '',
  isSensitive: true,
};

function BankingConfigPage() {
  const router = useRouter();
  const [country, setCountry] = useState('OM');
  const [rows, setRows] = useState<BankingFieldRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<UpsertBankingFieldData>(EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // The one heading for this route, rendered by TopHeader.
  usePageHeader(
    'Banking Field Config',
    'Define per-country banking fields — drives dynamic forms + validation',
  );

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await bankingConfigService.list(country);
      setRows(Array.isArray(res.data) ? res.data : []);
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Failed to load config'));
    } finally {
      setLoading(false);
    }
  }, [country]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    if (!form.fieldKey.trim() || !form.label.trim())
      return toast.warning('Key and label are required');
    setSaving(true);
    try {
      // form.country carries the row's country (set on edit / country switch).
      await bankingConfigService.upsert(form);
      toast.success(editingId ? 'Field updated' : 'Field saved');
      setForm({ ...EMPTY, country: form.country });
      setEditingId(null);
      await load();
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Failed to save'));
    } finally {
      setSaving(false);
    }
  };

  const edit = (r: BankingFieldRow) => {
    setEditingId(r.id);
    setForm({
      country: r.country,
      fieldKey: r.fieldKey,
      label: r.label,
      fieldType: r.fieldType,
      validationType: r.validationType,
      regex: r.regex ?? '',
      required: r.required,
      displayOrder: r.displayOrder,
      placeholder: r.placeholder ?? '',
      helpText: r.helpText ?? '',
      isSensitive: r.isSensitive,
      isActive: r.isActive,
    });
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setForm({ ...EMPTY, country });
  };

  const remove = async (r: BankingFieldRow) => {
    if (!confirm(`Delete field "${r.label}" for ${r.country}?`)) return;
    try {
      await bankingConfigService.remove(r.id);
      toast.success('Field deleted');
      await load();
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Failed to delete'));
    }
  };

  const seed = async () => {
    try {
      const res = await bankingConfigService.seedDefaults();
      toast.success(`Seeded ${res.data?.created ?? 0} default field(s)`);
      await load();
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Failed to seed'));
    }
  };

  return (
    <div className="p-6">
      <div className="mb-6">
        <PageActionRow
          onBack={() => router.push('/dashboard/banks')}
          action={
            <button
              data-testid="bankfield-seed"
              onClick={seed}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              <Sparkles size={14} /> Seed defaults
            </button>
          }
        />
      </div>

      <div className="mb-4 flex items-center gap-2">
        <label className="text-sm text-slate-600">Country</label>
        <select
          data-testid="bankfield-country"
          value={country}
          onChange={(e) => {
            setCountry(e.target.value);
            setEditingId(null);
            setForm({ ...EMPTY, country: e.target.value });
          }}
          className="h-9 rounded-lg border border-slate-200 px-3 text-sm"
        >
          {COUNTRIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name} ({c.code})
            </option>
          ))}
        </select>
      </div>

      {/* Add / edit form */}
      <div className="mb-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      {editingId && (
        <div className="mb-3 flex items-center justify-between rounded-lg bg-brand-primary/5 px-3 py-2 text-sm text-brand-primary">
          <span>
            Editing <span className="font-semibold">{form.label || form.fieldKey}</span> ({form.country})
          </span>
          <button onClick={cancelEdit} className="inline-flex items-center gap-1 hover:underline">
            <X size={13} /> Cancel
          </button>
        </div>
      )}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <input
          data-testid="bankfield-label"
          value={form.label}
          onChange={(e) => setForm({ ...form, label: e.target.value })}
          placeholder="Display name (e.g. IFSC Code)"
          className="h-9 rounded-lg border border-slate-200 px-3 text-sm"
        />
        <input
          data-testid="bankfield-key"
          value={form.fieldKey}
          onChange={(e) => setForm({ ...form, fieldKey: e.target.value })}
          placeholder="Internal key (e.g. ifsc)"
          readOnly={!!editingId}
          title={editingId ? 'Key is fixed once created' : undefined}
          className={`h-9 rounded-lg border border-slate-200 px-3 text-sm font-mono ${editingId ? 'bg-slate-100 text-slate-500' : ''}`}
        />
        <select
          data-testid="bankfield-type"
          value={form.fieldType}
          onChange={(e) => setForm({ ...form, fieldType: e.target.value })}
          className="h-9 rounded-lg border border-slate-200 px-3 text-sm"
        >
          {FIELD_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select
          data-testid="bankfield-validation"
          value={form.validationType}
          onChange={(e) => setForm({ ...form, validationType: e.target.value })}
          className="h-9 rounded-lg border border-slate-200 px-3 text-sm"
        >
          {VALIDATION_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <input
          data-testid="bankfield-placeholder"
          value={form.placeholder ?? ''}
          onChange={(e) => setForm({ ...form, placeholder: e.target.value })}
          placeholder="Placeholder / help"
          className="h-9 rounded-lg border border-slate-200 px-3 text-sm"
        />
        <input
          data-testid="bankfield-order"
          type="number"
          value={form.displayOrder ?? 0}
          onChange={(e) => setForm({ ...form, displayOrder: Number(e.target.value) })}
          placeholder="Order"
          className="h-9 rounded-lg border border-slate-200 px-3 text-sm"
        />
        {form.validationType === 'REGEX' && (
          <input
            data-testid="bankfield-regex"
            value={form.regex ?? ''}
            onChange={(e) => setForm({ ...form, regex: e.target.value })}
            placeholder="Regex pattern"
            className="h-9 rounded-lg border border-slate-200 px-3 text-sm font-mono sm:col-span-3"
          />
        )}
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input
            data-testid="bankfield-required"
            type="checkbox"
            checked={form.required ?? true}
            onChange={(e) => setForm({ ...form, required: e.target.checked })}
          />
          Required
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input
            data-testid="bankfield-sensitive"
            type="checkbox"
            checked={form.isSensitive ?? true}
            onChange={(e) => setForm({ ...form, isSensitive: e.target.checked })}
          />
          Sensitive (mask)
        </label>
        <button
          data-testid="bankfield-save"
          onClick={save}
          disabled={saving}
          className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-brand-primary px-3 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus size={14} />}
          {editingId ? 'Update field' : 'Save field'}
        </button>
      </div>
      </div>

      {/* List */}
      {loading ? (
        <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white p-8 text-slate-500 shadow-sm">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading…
        </div>
      ) : rows.length === 0 ? (
        <div
          data-testid="bankfield-empty"
          className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-slate-400 shadow-sm"
        >
          No fields configured for {country}. Add one above or seed defaults.
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-3">Order</th>
                <th className="px-4 py-3">Label</th>
                <th className="px-4 py-3">Key</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Validation</th>
                <th className="px-4 py-3">Req</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr
                  key={r.id}
                  data-testid="bankfield-row"
                  data-field-id={r.id}
                  data-field-key={r.fieldKey}
                  data-validation={r.validationType}
                  data-required={String(r.required)}
                  className={r.isActive ? '' : 'opacity-50'}
                >
                  <td className="px-4 py-3">{r.displayOrder}</td>
                  <td className="px-4 py-3 font-medium text-slate-800">{r.label}</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-500">{r.fieldKey}</td>
                  <td className="px-4 py-3">{r.fieldType}</td>
                  <td className="px-4 py-3">{r.validationType}</td>
                  <td className="px-4 py-3">{r.required ? 'Yes' : 'No'}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-3">
                      <button
                        data-testid="bankfield-edit"
                        onClick={() => edit(r)}
                        className="text-brand-primary hover:underline"
                      >
                        Edit
                      </button>
                      <button
                        data-testid="bankfield-delete"
                        onClick={() => remove(r)}
                        className="text-red-400 hover:text-red-600"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function BankingConfigPageGuarded() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN']}>
      <BankingConfigPage />
    </ProtectedRoute>
  );
}

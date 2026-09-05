'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, X, Plus, Save } from 'lucide-react';
import { toast } from 'sonner';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import PageActionRow from '@/components/common/PageActionRow';
import bankService, { BranchCountries } from '@/services/bankService';
import { COUNTRIES, countryName } from '@/lib/countries';
import { usePageHeader } from '@/hooks/usePageHeader';
import { apiErrorMessage } from '@/utils/apiError';

function BranchCountriesPage() {
  const router = useRouter();
  const [rows, setRows] = useState<BranchCountries[]>([]);
  const [draft, setDraft] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);

  // The one heading for this route, rendered by TopHeader.
  usePageHeader(
    'Branch Banking Countries',
    'Allowed banking countries, per branch.',
  );

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await bankService.branchCountries();
      const data = Array.isArray(res.data) ? res.data : [];
      setRows(data);
      // Draft seeds from the explicit bankingCountries (fallback shown as hint only).
      setDraft(Object.fromEntries(data.map((b) => [b.id, [...b.bankingCountries]])));
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Failed to load branches'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const addCountry = (branchId: string, code: string) => {
    if (!code) return;
    setDraft((d) => {
      const cur = d[branchId] ?? [];
      if (cur.includes(code)) return d;
      return { ...d, [branchId]: [...cur, code] };
    });
  };

  const removeCountry = (branchId: string, code: string) =>
    setDraft((d) => ({ ...d, [branchId]: (d[branchId] ?? []).filter((c) => c !== code) }));

  const save = async (b: BranchCountries) => {
    setSavingId(b.id);
    try {
      await bankService.setBranchCountries(b.id, draft[b.id] ?? []);
      toast.success(`${b.name} updated`);
      await load();
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Failed to save'));
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="p-6">
      <div className="mb-6">
        <PageActionRow
          onBack={() => router.push('/dashboard/banks')}
        />
      </div>

      {loading ? (
        <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white p-8 text-slate-500 shadow-sm">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading…
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-slate-400 shadow-sm">
          No branches found.
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((b) => {
            const selected = draft[b.id] ?? [];
            const dirty =
              JSON.stringify([...selected].sort()) !==
              JSON.stringify([...b.bankingCountries].sort());
            return (
              <div
                key={b.id}
                data-testid="branch-country-card"
                data-branch-id={b.id}
                data-selected={selected.join(',')}
                data-dirty={String(dirty)}
                className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-slate-800">
                      {b.name}{' '}
                      <span className="text-xs font-normal text-slate-400">· {b.code}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-slate-400">
                      Location country: {b.country || '—'}
                      {selected.length === 0 && b.country
                        ? ` (banking falls back to ${b.country})`
                        : ''}
                    </p>
                  </div>
                  <button
                    data-testid="branch-country-save"
                    onClick={() => save(b)}
                    disabled={savingId === b.id || !dirty}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand-primary px-3 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                  >
                    {savingId === b.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save size={14} />}
                    Save
                  </button>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {selected.length === 0 && (
                    <span className="text-xs text-slate-400">No banking countries set.</span>
                  )}
                  {selected.map((c) => (
                    <span
                      key={c}
                      data-testid="branch-country-chip"
                      data-country={c}
                      className="inline-flex items-center gap-1 rounded-full bg-brand-primary/10 px-2.5 py-1 text-xs font-medium text-brand-primary"
                    >
                      {countryName(c)} ({c})
                      <button
                        data-testid="branch-country-remove"
                        onClick={() => removeCountry(b.id, c)}
                        className="hover:text-red-500"
                      >
                        <X size={12} />
                      </button>
                    </span>
                  ))}
                  <span className="inline-flex items-center gap-1">
                    <Plus size={13} className="text-slate-400" />
                    <select
                      data-testid="branch-country-add"
                      value=""
                      onChange={(e) => addCountry(b.id, e.target.value)}
                      className="h-8 rounded-lg border border-slate-200 px-2 text-xs"
                    >
                      <option value="">Add country…</option>
                      {COUNTRIES.filter((c) => !selected.includes(c.code)).map((c) => (
                        <option key={c.code} value={c.code}>
                          {c.name} ({c.code})
                        </option>
                      ))}
                    </select>
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function BranchCountriesPageGuarded() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER']}>
      <BranchCountriesPage />
    </ProtectedRoute>
  );
}

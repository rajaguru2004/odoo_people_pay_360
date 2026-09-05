'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Loader2, Power, Pencil, X, Check, ChevronDown, Search, Settings, Globe2 } from 'lucide-react';
import { toast } from 'sonner';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import PageActionRow from '@/components/common/PageActionRow';
import bankService, { Bank } from '@/services/bankService';
import { COUNTRIES, countryName } from '@/lib/countries';
import { usePageHeader } from '@/hooks/usePageHeader';
import { apiErrorMessage } from '@/utils/apiError';

type AddForm = { name: string; bankCode: string; swift: string };
const EMPTY: AddForm = { name: '', bankCode: '', swift: '' };

/** Searchable country dropdown over the full ISO-3166 list. */
function CountryPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (code: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return COUNTRIES;
    return COUNTRIES.filter(
      (c) => c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q),
    );
  }, [query]);

  return (
    <div className="relative w-72" ref={ref}>
      <button
        type="button"
        data-testid="bank-country-picker"
        data-country={value}
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 w-full items-center justify-between rounded-lg border border-slate-200 bg-white px-3 text-sm hover:border-slate-300 focus:border-brand-primary focus:outline-none"
      >
        <span className="truncate">
          {value ? `${countryName(value)} (${value})` : 'Select country…'}
        </span>
        <ChevronDown size={16} className="shrink-0 text-slate-400" />
      </button>
      {open && (
        <div className="absolute z-20 mt-1 w-full rounded-lg border border-slate-200 bg-white shadow-lg">
          <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2">
            <Search size={14} className="text-slate-400" />
            <input
              autoFocus
              data-testid="bank-country-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search country or code…"
              className="w-full text-sm focus:outline-none"
            />
          </div>
          <ul className="max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-sm text-slate-400">No match</li>
            ) : (
              filtered.map((c) => (
                <li key={c.code}>
                  <button
                    type="button"
                    data-testid="bank-country-option"
                    data-country={c.code}
                    onClick={() => {
                      onChange(c.code);
                      setOpen(false);
                      setQuery('');
                    }}
                    className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-slate-50 ${c.code === value ? 'bg-brand-primary/5 font-medium text-brand-primary' : 'text-slate-700'}`}
                  >
                    <span className="truncate">{c.name}</span>
                    <span className="ml-2 shrink-0 text-xs text-slate-400">{c.code}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

function BankMasterPage() {
  const router = useRouter();
  const [banks, setBanks] = useState<Bank[]>([]);
  const [loading, setLoading] = useState(true);
  const [country, setCountry] = useState('OM');
  const [form, setForm] = useState<AddForm>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<Bank>>({});

  // The one heading for this route, rendered by TopHeader.
  usePageHeader('Bank Master', 'Manage the banks employees can select, per country');

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await bankService.getAll(country);
      setBanks(Array.isArray(res.data) ? res.data : []);
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Failed to load banks'));
    } finally {
      setLoading(false);
    }
  }, [country]);

  useEffect(() => {
    load();
  }, [load]);

  const add = async () => {
    if (!country) return toast.warning('Select a country');
    if (!form.name.trim()) return toast.warning('Bank name is required');
    setSaving(true);
    try {
      await bankService.create({
        country,
        name: form.name.trim(),
        bankCode: form.bankCode?.trim() || undefined,
        swift: form.swift?.trim() || undefined,
      });
      toast.success('Bank added');
      setForm(EMPTY);
      await load();
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Failed to add bank'));
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (b: Bank) => {
    setEditId(b.id);
    setEditForm({ name: b.name, bankCode: b.bankCode ?? '', swift: b.swift ?? '' });
  };

  const saveEdit = async (id: string) => {
    try {
      await bankService.update(id, {
        name: editForm.name?.trim(),
        bankCode: (editForm.bankCode as string)?.trim() || undefined,
        swift: (editForm.swift as string)?.trim() || undefined,
      });
      toast.success('Bank updated');
      setEditId(null);
      await load();
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Failed to update bank'));
    }
  };

  const toggleActive = async (b: Bank) => {
    try {
      if (b.isActive) await bankService.deactivate(b.id);
      else await bankService.update(b.id, { isActive: true });
      toast.success(b.isActive ? 'Bank deactivated' : 'Bank reactivated');
      await load();
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Failed to update bank'));
    }
  };

  return (
    <div className="p-6">
      <div className="mb-6">
        <PageActionRow
          action={
            <>
              <button
                data-testid="bank-branch-countries"
                onClick={() => router.push('/dashboard/banks/branch-countries')}
                title="Per-branch allowed banking countries"
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                <Globe2 size={15} /> Branch Countries
              </button>
              <button
                data-testid="bank-field-config"
                onClick={() => router.push('/dashboard/banks/config')}
                title="Banking field configuration"
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                <Settings size={15} /> Field Config
              </button>
            </>
          }
        />
      </div>

      <div className="mb-4 flex items-center gap-2">
        <label className="text-sm text-slate-600">Country</label>
        <CountryPicker value={country} onChange={setCountry} />
      </div>

      {/* Add form — country code auto-filled from the selected country above */}
      <div
        data-testid="bank-add-form"
        className="mb-6 grid grid-cols-1 gap-2 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-5"
      >
        <div
          className="flex h-9 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm font-medium text-slate-600"
          title={countryName(country)}
        >
          {country || '—'}
        </div>
        <input
          data-testid="bank-name"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="Bank name"
          className="h-9 rounded-lg border border-slate-200 px-3 text-sm sm:col-span-2"
        />
        <input
          data-testid="bank-code"
          value={form.bankCode}
          onChange={(e) => setForm({ ...form, bankCode: e.target.value })}
          placeholder="Bank code (opt.)"
          className="h-9 rounded-lg border border-slate-200 px-3 text-sm"
        />
        <input
          data-testid="bank-swift"
          value={form.swift}
          onChange={(e) => setForm({ ...form, swift: e.target.value })}
          placeholder="SWIFT (opt.)"
          className="h-9 rounded-lg border border-slate-200 px-3 text-sm"
        />
        <button
          data-testid="bank-add"
          onClick={add}
          disabled={saving}
          className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-brand-primary px-3 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50 sm:col-span-5"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus size={14} />}
          Add bank
        </button>
      </div>

      {/* List */}
      {loading ? (
        <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white p-8 text-slate-500 shadow-sm">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading…
        </div>
      ) : banks.length === 0 ? (
        <div
          data-testid="bank-empty"
          className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-slate-400 shadow-sm"
        >
          No banks configured for {country}.
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Bank code</th>
                <th className="px-4 py-3">SWIFT</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {banks.map((b) => {
                const editing = editId === b.id;
                return (
                  <tr
                    key={b.id}
                    data-testid="bank-row"
                    data-bank-id={b.id}
                    data-bank-active={String(b.isActive)}
                    data-bank-name={b.name}
                    data-active={b.isActive}
                    className={b.isActive ? '' : 'opacity-60'}
                  >
                    <td className="px-4 py-3">
                      {editing ? (
                        <input
                          data-testid="bank-name"
                          value={editForm.name as string}
                          onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                          className="h-8 w-full rounded border border-slate-200 px-2"
                        />
                      ) : (
                        <span className="font-medium text-slate-800">{b.name}</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {editing ? (
                        <input
                          data-testid="bank-code"
                          value={(editForm.bankCode as string) ?? ''}
                          onChange={(e) => setEditForm({ ...editForm, bankCode: e.target.value })}
                          className="h-8 w-24 rounded border border-slate-200 px-2"
                        />
                      ) : (
                        b.bankCode || <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {editing ? (
                        <input
                          data-testid="bank-swift"
                          value={(editForm.swift as string) ?? ''}
                          onChange={(e) => setEditForm({ ...editForm, swift: e.target.value })}
                          className="h-8 w-32 rounded border border-slate-200 px-2"
                        />
                      ) : (
                        b.swift || <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${b.isActive ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}
                      >
                        {b.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        {editing ? (
                          <>
                            <button
                              data-testid="bank-save"
                              onClick={() => saveEdit(b.id)}
                              className="text-emerald-600 hover:text-emerald-700"
                            >
                              <Check size={16} />
                            </button>
                            <button
                              data-testid="bank-cancel-edit"
                              onClick={() => setEditId(null)}
                              className="text-slate-400 hover:text-slate-600"
                            >
                              <X size={16} />
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              data-testid="bank-edit"
                              onClick={() => startEdit(b)}
                              className="text-slate-400 hover:text-brand-primary"
                            >
                              <Pencil size={16} />
                            </button>
                            <button
                              data-testid="bank-toggle-active"
                              onClick={() => toggleActive(b)}
                              className={b.isActive ? 'text-red-400 hover:text-red-600' : 'text-emerald-500 hover:text-emerald-700'}
                              title={b.isActive ? 'Deactivate' : 'Reactivate'}
                            >
                              <Power size={16} />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function BankMasterPageGuarded() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN']}>
      <BankMasterPage />
    </ProtectedRoute>
  );
}

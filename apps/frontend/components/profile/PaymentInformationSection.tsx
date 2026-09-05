'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Landmark, Loader2, Clock, ShieldCheck, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import bankService, { Bank } from '@/services/bankService';
import bankChangeService, {
  BankingField,
  CurrentBankDetail,
} from '@/services/bankChangeService';
import bankingConfigService from '@/services/bankingConfigService';
import { countryName } from '@/lib/countries';
import { apiErrorMessage, apiFieldErrors } from '@/utils/apiError';

/**
 * Payment Information — dynamic + country-aware. A branch allows one or more
 * banking countries; the employee picks one (auto-selected if only one), the
 * field schema + banks come from that country's config. Changes never edit the
 * record directly — they create a BankChangeRequest via the approval engine.
 *
 * Self-service when no `employeeId`; admin/HR view of an employee when given.
 */
export default function PaymentInformationSection({
  employeeId,
}: {
  employeeId?: string;
} = {}) {
  const [current, setCurrent] = useState<CurrentBankDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [country, setCountry] = useState('');
  const [banks, setBanks] = useState<Bank[]>([]);
  const [fields, setFields] = useState<BankingField[]>([]);
  const [ctxLoading, setCtxLoading] = useState(false);
  const [bankId, setBankId] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});

  const countries = current?.countries ?? [];

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const curRes = employeeId
        ? await bankChangeService.currentFor(employeeId)
        : await bankChangeService.current();
      setCurrent(curRes.data);
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Failed to load payment info'));
    } finally {
      setLoading(false);
    }
  }, [employeeId]);

  useEffect(() => {
    load();
  }, [load]);

  // Load fields + banks whenever the selected country changes (edit mode).
  useEffect(() => {
    if (!editing || !country) {
      setFields([]);
      setBanks([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setCtxLoading(true);
      try {
        const [fRes, bRes] = await Promise.all([
          bankingConfigService.fields(country),
          bankService.getAll(country, true),
        ]);
        if (cancelled) return;
        const fs = Array.isArray(fRes.data) ? fRes.data : [];
        setFields(fs);
        setBanks(Array.isArray(bRes.data) ? bRes.data : []);
        setValues((v) => {
          const next: Record<string, string> = {};
          for (const f of fs) next[f.fieldKey] = v[f.fieldKey] ?? '';
          return next;
        });
      } catch {
        if (!cancelled) {
          setFields([]);
          setBanks([]);
        }
      } finally {
        if (!cancelled) setCtxLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [editing, country]);

  const startEdit = () => {
    setBankId('');
    setValues({});
    setCountry(countries.length === 1 ? countries[0] : '');
    setEditing(true);
  };

  const submit = async () => {
    if (!country) return toast.warning('Select a country');
    if (!bankId) return toast.warning('Select a bank');
    for (const f of fields) {
      if (f.required && !values[f.fieldKey]?.trim())
        return toast.warning(`${f.label} is required`);
    }
    setSaving(true);
    try {
      await bankChangeService.create({
        ...(employeeId ? { employeeId } : {}),
        bankId,
        data: values,
      });
      toast.success('Bank change request submitted for approval');
      setEditing(false);
      setBankId('');
      setValues({});
      await load();
    } catch (e: unknown) {
      // The server answers a bad account with per-FIELD reasons. Collapsing them
      // into one toast made the user hunt for which input was wrong — and under
      // the old flat-error read they never arrived at all.
      const errs = apiFieldErrors(e);
      if (errs) {
        setFieldErrors(errs);
        toast.error(Object.values(errs).join('\n'));
      } else {
        setFieldErrors({});
        toast.error(apiErrorMessage(e, 'Failed to submit request'));
      }
    } finally {
      setSaving(false);
    }
  };

  const pending = !!current?.pendingRequestId;
  const detail = current?.detail;
  const detailFields = detail?.fields ?? [];
  const noCountries = !loading && countries.length === 0;

  return (
    <div className="bg-surface-card rounded-[--radius-card] border border-surface-border">
      <div className="px-6 py-4 border-b border-surface-border flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center bg-brand-primary/10">
            <Landmark size={18} className="text-brand-primary" />
          </div>
          <div>
            <h3 className="font-semibold text-text-heading">Payment Information</h3>
            <p className="text-xs text-slate-500">
              {countries.length ? `Countries: ${countries.join(', ')} · ` : ''}Bank changes require approval
            </p>
          </div>
        </div>
        {!editing && !pending && !noCountries && (
          <button data-testid="pay-info-request-change" onClick={startEdit} className="text-sm font-medium text-brand-primary hover:underline">
            Request change
          </button>
        )}
      </div>

      <div className="p-6">
        {loading ? (
          <div className="flex items-center gap-2 text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (
          <>
            {pending && (
              <div
                data-testid="pay-info-pending"
                className="mb-4 flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700"
              >
                <Clock size={14} /> A bank change request is pending approval.
              </div>
            )}
            {noCountries && (
              <div className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">
                <AlertCircle size={14} /> No banking countries are set for this employee&apos;s
                branch. Configure them under Bank Master → Branch Countries.
              </div>
            )}

            {/* Current approved detail (rendered against its own country fields) */}
            {detail && (
              <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-3">
                <Field label="Bank" value={detail.bankName} />
                <Field label="Country" value={detail.country} />
                {detailFields.map((f) => (
                  <Field key={f.fieldKey} label={f.label} value={detail.values?.[f.fieldKey]} />
                ))}
              </div>
            )}
            {detail ? (
              <p className="flex items-center gap-1 text-xs text-emerald-600">
                <ShieldCheck size={12} /> Approved details in use by payroll
              </p>
            ) : (
              !noCountries &&
              !pending && (
                <p className="text-xs text-slate-400">
                  No approved bank details yet. Request a change to add them.
                </p>
              )
            )}

            {/* Change request form (dynamic, country-driven) */}
            {editing && !pending && !noCountries && (
              <div className="mt-5 space-y-3 border-t border-surface-border pt-5">
                {countries.length > 1 && (
                  <label className="block text-sm">
                    <span className="mb-1 block text-slate-600">Country</span>
                    <select
                      value={country}
                      onChange={(e) => {
                        setCountry(e.target.value);
                        setBankId('');
                      }}
                      className="h-9 w-full rounded-lg border border-slate-200 px-3 text-sm md:w-1/2"
                    >
                      <option value="">Select country…</option>
                      {countries.map((c) => (
                        <option key={c} value={c}>
                          {countryName(c)} ({c})
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                {!country ? (
                  <p className="text-sm text-slate-400">Select a country to continue.</p>
                ) : ctxLoading ? (
                  <div className="flex items-center gap-2 text-sm text-slate-500">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading fields…
                  </div>
                ) : fields.length === 0 ? (
                  <p className="text-sm text-amber-600">
                    No banking fields configured for {country}.
                  </p>
                ) : banks.length === 0 ? (
                  <p className="text-sm text-amber-600">No banks configured for {country}.</p>
                ) : (
                  <>
                    <label className="block text-sm">
                      <span className="mb-1 block text-slate-600">Bank ({country})</span>
                      <select
                        data-testid="pay-info-bank"
                        value={bankId}
                        onChange={(e) => setBankId(e.target.value)}
                        className="h-9 w-full rounded-lg border border-slate-200 px-3 text-sm md:w-1/2"
                      >
                        <option value="">Select bank…</option>
                        {banks.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      {fields.map((f) => (
                        <label key={f.fieldKey} className="block text-sm">
                          <span className="mb-1 block text-slate-600">
                            {f.label}
                            {f.required && <span className="text-red-500"> *</span>}
                          </span>
                          <input
                            data-testid={`pay-info-field-${f.fieldKey}`}
                            value={values[f.fieldKey] ?? ''}
                            onChange={(e) => {
                              setValues((v) => ({ ...v, [f.fieldKey]: e.target.value }));
                              setFieldErrors((prev) => {
                                if (!prev[f.fieldKey]) return prev;
                                const next = { ...prev };
                                delete next[f.fieldKey];
                                return next;
                              });
                            }}
                            placeholder={f.placeholder ?? ''}
                            inputMode={f.fieldType === 'NUMBER' ? 'numeric' : undefined}
                            className="h-9 w-full rounded-lg border border-slate-200 px-3 text-sm"
                          />
                          {fieldErrors[f.fieldKey] ? (
                            <span
                              data-testid={`pay-info-error-${f.fieldKey}`}
                              className="mt-0.5 block text-xs text-red-600"
                            >
                              {fieldErrors[f.fieldKey]}
                            </span>
                          ) : (
                            f.helpText && (
                              <span className="mt-0.5 block text-xs text-slate-400">
                                {f.helpText}
                              </span>
                            )
                          )}
                        </label>
                      ))}
                    </div>
                  </>
                )}

                <div className="flex justify-end gap-2">
                  <button
                    data-testid="pay-info-cancel"
                    onClick={() => setEditing(false)}
                    className="h-9 rounded-lg border border-slate-200 px-3 text-sm text-slate-600 hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                  <button
                    data-testid="pay-info-submit"
                    onClick={submit}
                    disabled={saving || !country || !bankId || fields.length === 0}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand-primary px-4 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                  >
                    {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                    Submit for approval
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value?: string | null }) {
  return (
    <div>
      <p className="text-xs text-slate-400">{label}</p>
      <p className="text-sm font-medium text-text-heading">
        {value || <span className="text-slate-300">—</span>}
      </p>
    </div>
  );
}

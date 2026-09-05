'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Check, AlertCircle, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import bankService, { Bank } from '@/services/bankService';
import bankChangeService, {
  BankingField,
  MigrationCandidate,
} from '@/services/bankChangeService';
import bankingConfigService from '@/services/bankingConfigService';
import { countryName } from '@/lib/countries';
import { isDevMode, sampleValuesForFields } from '@/utils/devBankSample';
import { apiErrorMessage, apiFieldErrors } from '@/utils/apiError';

interface RowState {
  country: string;
  bankId: string;
  values: Record<string, string>;
  saving: boolean;
}

function MigratePage() {
  const [candidates, setCandidates] = useState<MigrationCandidate[]>([]);
  const [banks, setBanks] = useState<Bank[]>([]);
  const [fieldsByCountry, setFieldsByCountry] = useState<Record<string, BankingField[]>>({});
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [loading, setLoading] = useState(true);

  // The one heading for this route, rendered by TopHeader.
  usePageHeader(
    'Bank Detail Migration',
    "Fields + banks are driven by the employee's branch banking countries.",
  );

  const seedValues = (c: MigrationCandidate, fields: BankingField[]) => {
    const values: Record<string, string> = {};
    for (const f of fields)
      values[f.fieldKey] =
        f.fieldKey === 'accountHolderName'
          ? c.profile?.bankAccountHolderName || c.fullName
          : '';
    return values;
  };

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [candRes, bankRes] = await Promise.all([
        bankChangeService.migrationCandidates(),
        bankService.getAll(undefined, true),
      ]);
      const cands = Array.isArray(candRes.data) ? candRes.data : [];
      setCandidates(cands);
      setBanks(Array.isArray(bankRes.data) ? bankRes.data : []);

      const countries = Array.from(new Set(cands.flatMap((c) => c.countries)));
      const entries = await Promise.all(
        countries.map(async (c) => {
          try {
            const r = await bankingConfigService.fields(c);
            return [c, Array.isArray(r.data) ? r.data : []] as const;
          } catch {
            return [c, [] as BankingField[]] as const;
          }
        }),
      );
      const fbc = Object.fromEntries(entries);
      setFieldsByCountry(fbc);

      const init: Record<string, RowState> = {};
      for (const c of cands) {
        const ctry = c.countries.length === 1 ? c.countries[0] : '';
        init[c.id] = {
          country: ctry,
          bankId: '',
          values: ctry ? seedValues(c, fbc[ctry] ?? []) : {},
          saving: false,
        };
      }
      setRows(init);
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Failed to load migration data'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const patch = (id: string, p: Partial<RowState>) =>
    setRows((r) => ({ ...r, [id]: { ...r[id], ...p } }));

  const changeCountry = (c: MigrationCandidate, country: string) => {
    patch(c.id, {
      country,
      bankId: '',
      values: country ? seedValues(c, fieldsByCountry[country] ?? []) : {},
    });
  };

  /**
   * DEV ONLY. Fills the row with values built to pass validation for the country
   * and bank currently selected — a valid mod-97 IBAN carrying that bank's code.
   * Picks the first bank for the country if none is chosen yet, since the IBAN
   * cannot be generated without knowing which bank it must route to.
   */
  const devAutofill = (c: MigrationCandidate) => {
    const row = rows[c.id];
    const country = row?.country || (c.countries.length === 1 ? c.countries[0] : '');
    if (!country) return toast.warning('Select a country first');

    const fields = fieldsByCountry[country] ?? [];
    if (fields.length === 0) return toast.warning(`No fields configured for ${country}`);

    const countryBanks = banks.filter((b) => b.country === country);
    const bankId = row?.bankId || countryBanks[0]?.id || '';
    const bank = countryBanks.find((b) => b.id === bankId);
    if (!bank) return toast.warning(`No banks configured for ${country}`);

    const values = sampleValuesForFields(fields, {
      country,
      bankCode: bank.bankCode,
      holderName: c.profile?.bankAccountHolderName || c.fullName,
      seedKey: c.id,
    });

    const missing = fields
      .filter((f) => f.required && !values[f.fieldKey])
      .map((f) => f.label);

    patch(c.id, { country, bankId, values: { ...row?.values, ...values } });

    if (missing.length) {
      toast.warning(`Filled what I could — enter manually: ${missing.join(', ')}`);
    } else {
      toast.success(
        bank.bankCode
          ? `Sample data for ${bank.name} (code ${bank.bankCode})`
          : `Sample data for ${bank.name} — no bank code on file, so the IBAN uses zeros`,
      );
    }
  };

  const migrate = async (c: MigrationCandidate) => {
    const row = rows[c.id];
    const fields = fieldsByCountry[row?.country] ?? [];
    if (!row?.country) return toast.warning('Select a country');
    if (!row?.bankId) return toast.warning('Select a bank');
    for (const f of fields) {
      if (f.required && !row.values[f.fieldKey]?.trim())
        return toast.warning(`${f.label} is required`);
    }
    patch(c.id, { saving: true });
    try {
      await bankChangeService.migrate({ employeeId: c.id, bankId: row.bankId, data: row.values });
      toast.success(`${c.fullName} migrated`);
      setCandidates((cs) => cs.filter((x) => x.id !== c.id));
    } catch (e: any) {
      // The server answers a bad IBAN with { message, errors: { iban: '…' } }.
      // `lib/axios` rejects with a FLAT object, so `e.response.data` is always
      // undefined and this used to degrade "IBAN check digits are invalid — a
      // character is mistyped or transposed" into "Failed to migrate". The bank
      // rejects the ENTIRE wage file over one mistyped digit, so the sentence
      // that names which field is wrong is the whole value of the refusal.
      const errs = apiFieldErrors(e);
      toast.error(errs ? Object.values(errs).join('\n') : apiErrorMessage(e, 'Failed to migrate'));
      patch(c.id, { saving: false });
    }
  };

  return (
    <div className="p-6">
      {loading ? (
        <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white p-8 text-slate-500 shadow-sm">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading…
        </div>
      ) : candidates.length === 0 ? (
        <div
          data-testid="migrate-empty"
          className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-slate-400 shadow-sm"
        >
          No employees left to migrate. 🎉
        </div>
      ) : (
        <div className="space-y-3">
          {candidates.map((c) => {
            const row = rows[c.id];
            const p = c.profile || {};
            const fields = fieldsByCountry[row?.country] ?? [];
            const countryBanks = banks.filter((b) => b.country === row?.country);
            const noCountries = c.countries.length === 0;
            const noFields = !!row?.country && fields.length === 0;
            const noBanks = !!row?.country && fields.length > 0 && countryBanks.length === 0;
            return (
              <div
                key={c.id}
                data-testid="migrate-row"
                data-employee-id={c.id}
                data-countries={c.countries.join(',')}
                className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
              >
                <div className="mb-3">
                  <p className="text-sm font-semibold text-slate-800">
                    {c.fullName}{' '}
                    <span className="text-xs font-normal text-slate-400">
                      · {c.employeeCode} · {c.countries.join(', ') || 'no country'}
                    </span>
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Legacy: {p.bankName || '—'}
                    {p.bankBranch ? ` (${p.bankBranch})` : ''} · acct{' '}
                    {p.bankAccountNumber || '—'} · holder {p.bankAccountHolderName || '—'}
                  </p>
                </div>

                {noCountries ? (
                  <div className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">
                    <AlertCircle size={14} /> No banking countries set for this branch — set
                    them under Bank Master → Branch Countries.
                  </div>
                ) : (
                  <>
                    <div className="mb-2 flex flex-wrap gap-2">
                      {c.countries.length > 1 && (
                        <select
                          data-testid="migrate-country"
                          value={row?.country ?? ''}
                          onChange={(e) => changeCountry(c, e.target.value)}
                          className="h-9 rounded-lg border border-slate-200 px-3 text-sm"
                        >
                          <option value="">Select country…</option>
                          {c.countries.map((cc) => (
                            <option key={cc} value={cc}>
                              {countryName(cc)} ({cc})
                            </option>
                          ))}
                        </select>
                      )}
                      {row?.country && (
                        <select
                          data-testid="migrate-bank"
                          value={row?.bankId ?? ''}
                          onChange={(e) => patch(c.id, { bankId: e.target.value })}
                          className="h-9 rounded-lg border border-slate-200 px-3 text-sm"
                        >
                          <option value="">Select bank ({row.country})…</option>
                          {countryBanks.map((b) => (
                            <option key={b.id} value={b.id}>
                              {b.name}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>

                    {noFields ? (
                      <p className="text-sm text-amber-600">No fields configured for {row?.country}.</p>
                    ) : noBanks ? (
                      <p className="text-sm text-amber-600">No banks configured for {row?.country}.</p>
                    ) : row?.country ? (
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                        {fields.map((f) => (
                          <input
                            key={f.fieldKey}
                            data-testid={`migrate-field-${f.fieldKey}`}
                            value={row?.values[f.fieldKey] ?? ''}
                            onChange={(e) =>
                              patch(c.id, { values: { ...row.values, [f.fieldKey]: e.target.value } })
                            }
                            placeholder={`${f.label}${f.required ? ' *' : ''}`}
                            className="h-9 rounded-lg border border-slate-200 px-3 text-sm"
                          />
                        ))}
                      </div>
                    ) : null}

                    <div className="mt-3 flex items-center justify-end gap-2">
                      {/* Dev-only: compiled out of production builds. */}
                      {isDevMode() && (
                        <button
                          type="button"
                          data-testid="migrate-autofill"
                          onClick={() => devAutofill(c)}
                          disabled={row?.saving}
                          title="Dev only — fills a valid mod-97 IBAN carrying the selected bank's code"
                          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-dashed border-amber-400 bg-amber-50 px-3 text-sm font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-50"
                        >
                          <Wand2 size={14} />
                          Autofill (dev)
                        </button>
                      )}
                      <button
                        data-testid="migrate-submit"
                        onClick={() => migrate(c)}
                        disabled={row?.saving || !row?.country || !row?.bankId}
                        className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand-primary px-3 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                      >
                        {row?.saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check size={14} />}
                        Migrate &amp; verify
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function MigratePageGuarded() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER']}>
      <MigratePage />
    </ProtectedRoute>
  );
}

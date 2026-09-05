'use client';

import React, { useEffect, useMemo, useState } from 'react';
import systemSettingsService from '@/services/systemSettingsService';
import { toast } from '@/lib/toast';
import { apiErrorMessage } from '@/utils/apiError';

/**
 * The rest of the loan policy.
 *
 * The settings screen exposed four keys — enabled, approver roles, maximum
 * instalments, advance ceiling — while the backend read **thirty-eight**. The
 * missing thirty-four were not obscure: they decide the take-home floor, what
 * happens when pay cannot cover an instalment, which loan is recovered first,
 * who may write one off. An administrator could only change them with a raw
 * POST.
 *
 * This panel is driven by the server's OWN registry (`GET /system-settings`)
 * rather than a hand-written list of fields, for one reason: a hard-coded form
 * is how the screen and the engine drifted apart in the first place. A key the
 * backend starts reading appears here the moment it is registered, and one that
 * is retired disappears — which is the property that keeps this honest.
 *
 * Values are typed by their shape, not by a schema the client duplicates:
 * `true`/`false` render as a toggle, a number as a number field, an enumerated
 * value is left as text because the client is not told the allowed set — the
 * server validates it and its refusal is shown verbatim.
 */

/** Keys the dedicated controls above already own. */
const OWNED_ELSEWHERE = new Set([
  'advance_loan_enabled',
  'advance_loan_approver_roles',
  'advance_loan_max_installments',
  'advance_max_percent_of_salary',
]);

const IS_LOAN_KEY = (key: string) =>
  key.startsWith('loan_') || key.startsWith('advance_loan_');

interface SettingRow {
  key: string;
  value: string;
  description?: string;
}

export default function LoanPolicySettings() {
  const [rows, setRows] = useState<SettingRow[]>([]);
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    setFailed(null);
    try {
      const res: any = await systemSettingsService.getAll();
      const all: SettingRow[] = Array.isArray(res) ? res : (res?.data ?? []);
      setRows(all.filter((r) => IS_LOAN_KEY(r.key) && !OWNED_ELSEWHERE.has(r.key)));
      setEdited({});
    } catch (e) {
      const reason = apiErrorMessage(e, 'Could not load the loan policy settings');
      setFailed(reason);
      setRows([]);
      toast.error(reason);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // Loaded once: this panel is only mounted on the Advance & Loan tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = useMemo(() => Object.keys(edited), [edited]);

  const valueOf = (row: SettingRow) => edited[row.key] ?? row.value;

  const setValue = (key: string, value: string) =>
    setEdited((e) => ({ ...e, [key]: value }));

  const save = async () => {
    if (dirty.length === 0) return;
    try {
      setSaving(true);
      await systemSettingsService.update(edited);
      toast.success(
        `${dirty.length} loan setting${dirty.length === 1 ? '' : 's'} saved`,
      );
      await load();
    } catch (e) {
      // The server validates each value against `SETTING_VALUE_RULES` and names
      // the key and the allowed set. That sentence is the useful one.
      toast.error(apiErrorMessage(e, 'Could not save the loan policy settings'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <p className="text-sm text-text-muted">Loading the loan policy…</p>;
  }

  if (failed) {
    return (
      <div
        data-testid="loan-policy-failed"
        className="rounded-lg border border-status-error bg-status-error-bg p-3"
      >
        <p className="text-sm font-medium text-text-heading">
          The loan policy could not be loaded
        </p>
        <p className="mt-1 text-sm text-text-muted">{failed}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="loan-policy-settings" data-count={rows.length}>
      <p className="text-xs text-text-muted">
        Everything else the loan engine reads. Values are validated by the
        server; an invalid one is refused with the reason rather than stored.
      </p>

      <div className="space-y-2">
        {rows.map((row) => {
          const value = valueOf(row);
          const isBool = row.value === 'true' || row.value === 'false';
          const isNumeric = !isBool && row.value !== '' && !Number.isNaN(Number(row.value));

          return (
            <div
              key={row.key}
              data-testid="loan-policy-row"
              data-key={row.key}
              data-dirty={String(edited[row.key] !== undefined)}
              className="rounded-lg border border-surface-border p-3"
            >
              <div className="flex flex-wrap items-center gap-3">
                <code className="text-xs font-medium text-text-heading">{row.key}</code>
                <div className="ms-auto">
                  {isBool ? (
                    <input
                      data-testid="loan-policy-toggle"
                      type="checkbox"
                      checked={value === 'true'}
                      onChange={(e) =>
                        setValue(row.key, e.target.checked ? 'true' : 'false')
                      }
                    />
                  ) : (
                    <input
                      data-testid="loan-policy-value"
                      type={isNumeric ? 'number' : 'text'}
                      step="any"
                      value={value}
                      onChange={(e) => setValue(row.key, e.target.value)}
                      className="h-9 w-64 rounded-lg border border-surface-border px-2 text-sm"
                    />
                  )}
                </div>
              </div>
              {row.description && (
                <p className="mt-1 text-[11px] text-text-muted">{row.description}</p>
              )}
            </div>
          );
        })}
      </div>

      <button
        data-testid="loan-policy-save"
        disabled={saving || dirty.length === 0}
        onClick={save}
        className="rounded-lg bg-brand-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {saving
          ? 'Saving…'
          : dirty.length === 0
            ? 'No changes'
            : `Save ${dirty.length} change${dirty.length === 1 ? '' : 's'}`}
      </button>
    </div>
  );
}

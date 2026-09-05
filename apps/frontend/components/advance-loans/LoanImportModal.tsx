'use client';

import React, { useState } from 'react';
import { Download, Loader2, Upload, X } from 'lucide-react';
import advanceLoanService from '@/services/advanceLoanService';
import { ImportPreviewRow } from '@/types/advanceLoan';
import { formatCurrency } from '@/utils/formatters';
import { toast } from '@/lib/toast';
import { apiErrorMessage } from '@/utils/apiError';

type Step = 'UPLOAD' | 'PREVIEW' | 'IMPORTING' | 'RESULTS';

/**
 * Bulk import of loans that already exist elsewhere — a migration from a
 * spreadsheet or a legacy system, typically mid-life and part repaid.
 *
 * Preview persists NOTHING, so an operator can iterate on a bad file without
 * leaving half-imported loans behind; only the rows they choose are sent to
 * confirm, and invalid rows are never selectable.
 */
export default function LoanImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [step, setStep] = useState<Step>('UPLOAD');
  const [rows, setRows] = useState<ImportPreviewRow[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [results, setResults] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);

  const downloadTemplate = async () => {
    try {
      const blob = await advanceLoanService.downloadImportTemplate();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'loan_import_template.xlsx';
      // Anchored in the document and revoked on the NEXT tick, not synchronously.
      // A detached anchor is not reliably clickable, and revoking the object URL
      // in the same statement as the click can pull the blob out from under a
      // download that has not started yet — the browser then does nothing at
      // all, silently, which looks exactly like a dead button.
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      toast.error('Could not download the template');
    }
  };

  const onFile = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try {
      const res: any = await advanceLoanService.previewImport(file);
      setRows(res?.rows ?? []);
      setSummary(res?.summary ?? null);
      setStep('PREVIEW');
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Could not read that file'));
    } finally {
      setBusy(false);
    }
  };

  const confirmImport = async () => {
    const valid = rows.filter((r) => r.valid).map((r) => r.data);
    if (!valid.length) {
      toast.error('There are no valid rows to import');
      return;
    }
    setStep('IMPORTING');
    try {
      const res: any = await advanceLoanService.confirmImport(valid);
      setResults(res?.results ?? []);
      setSummary(res?.summary ?? null);
      setStep('RESULTS');
      onDone();
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'The import failed'));
      setStep('PREVIEW');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        data-testid="loan-import-modal"
        data-step={step}
        className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-xl bg-surface-card shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-surface-border p-4">
          <h3 className="text-lg font-semibold">Import loans</h3>
          <button onClick={onClose} aria-label="Close" className="rounded p-1 hover:bg-surface-page">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {step === 'UPLOAD' && (
            <div className="space-y-4">
              <p className="text-sm text-text-muted">
                Import existing loans, including part-repaid ones. Consumed
                instalments are written into the repayment ledger, so payroll
                resumes at the next instalment instead of recovering the loan
                from the beginning again.
              </p>
              <button
                data-testid="loan-import-template"
                onClick={downloadTemplate}
                className="flex items-center gap-2 rounded-lg border border-surface-border px-3 py-2 text-sm hover:bg-surface-page"
              >
                <Download size={16} /> Download template
              </button>
              <label className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed border-surface-border p-8 text-sm text-text-muted hover:bg-surface-page">
                {busy ? <Loader2 size={20} className="animate-spin" /> : <Upload size={20} />}
                <span>{busy ? 'Reading…' : 'Choose an .xlsx file'}</span>
                <input
                  data-testid="loan-import-file"
                  type="file"
                  accept=".xlsx,.xls"
                  className="hidden"
                  disabled={busy}
                  onChange={(e) => onFile(e.target.files?.[0])}
                />
              </label>
            </div>
          )}

          {step === 'PREVIEW' && (
            <div className="space-y-3">
              <div className="flex gap-4 text-sm">
                <span data-testid="loan-import-rows" data-count={summary?.totalRows ?? 0}>
                  {summary?.totalRows ?? 0} rows
                </span>
                <span
                  data-testid="loan-import-valid"
                  data-count={summary?.validRows ?? 0}
                  className="text-status-success"
                >
                  {summary?.validRows ?? 0} valid
                </span>
                <span
                  data-testid="loan-import-invalid"
                  data-count={summary?.invalidRows ?? 0}
                  className="text-status-error"
                >
                  {summary?.invalidRows ?? 0} invalid
                </span>
              </div>
              <p className="text-xs text-text-muted">
                Only valid rows are imported. Nothing has been created yet.
              </p>
              <div className="overflow-x-auto rounded-lg border border-surface-border">
                <table className="w-full min-w-[760px] text-sm">
                  <thead>
                    <tr className="border-b border-surface-border text-left text-xs uppercase text-text-muted">
                      <th className="px-2 py-2">Row</th>
                      <th className="px-2 py-2">Employee</th>
                      <th className="px-2 py-2">Reference</th>
                      <th className="px-2 py-2 text-right">Principal</th>
                      <th className="px-2 py-2 text-right">Instalment</th>
                      <th className="px-2 py-2">Next due</th>
                      <th className="px-2 py-2">Issues</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr
                        key={r.rowNumber}
                        className={`border-b border-surface-border-light ${r.valid ? '' : 'bg-status-error/5'}`}
                      >
                        <td className="px-2 py-2">{r.rowNumber}</td>
                        <td className="px-2 py-2">{r.data.employeeCode}</td>
                        <td className="px-2 py-2">{r.data.referenceNo}</td>
                        <td className="px-2 py-2 text-right">
                          {formatCurrency(Number(r.data.principal) || 0)}
                        </td>
                        <td className="px-2 py-2 text-right">
                          {r.derived ? formatCurrency(r.derived.emi) : '—'}
                        </td>
                        <td className="px-2 py-2">{r.derived?.nextDuePeriod ?? '—'}</td>
                        <td className="px-2 py-2">
                          {r.errors.map((e, i) => (
                            <div key={i} className="text-xs text-status-error">{e}</div>
                          ))}
                          {r.warnings.map((w, i) => (
                            <div key={i} className="text-xs text-status-warning">{w}</div>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {step === 'IMPORTING' && (
            <div className="flex items-center justify-center gap-2 p-10 text-sm text-text-muted">
              <Loader2 size={18} className="animate-spin" /> Importing…
            </div>
          )}

          {step === 'RESULTS' && (
            <div
              data-testid="loan-import-results"
              data-imported={summary?.imported ?? 0}
              data-failed={summary?.failed ?? 0}
              className="space-y-3"
            >
              <div className="flex gap-4 text-sm">
                <span className="text-status-success">{summary?.imported ?? 0} imported</span>
                <span className="text-status-error">{summary?.failed ?? 0} failed</span>
              </div>
              <ul className="space-y-1 text-sm">
                {results.map((r, i) => (
                  <li key={i} className={r.success ? '' : 'text-status-error'}>
                    {r.referenceNo}: {r.success ? 'imported' : r.error}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-surface-border p-4">
          <button
            data-testid="loan-import-cancel"
            onClick={onClose}
            className="rounded-lg border border-surface-border px-4 py-2 text-sm"
          >
            {step === 'RESULTS' ? 'Done' : 'Cancel'}
          </button>
          {step === 'PREVIEW' && (
            <button
              data-testid="loan-import-confirm"
              onClick={confirmImport}
              disabled={!summary?.validRows}
              className="rounded-lg bg-brand-primary px-4 py-2 text-sm text-text-on-brand disabled:opacity-60"
            >
              Import {summary?.validRows ?? 0} loan(s)
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

'use client';

import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import documentTemplateService from '@/services/documentTemplateService';
import { getApiErrorMessage } from '@/lib/apiError';
import { useBrandingStore } from '@/store/brandingStore';

export interface GenerateDocumentButtonProps {
  documentType: string;
  employeeId?: string;
  subjectId?: string;
  params?: Record<string, unknown>;
  locale?: string;
  label?: string;
  className?: string;
  'data-testid'?: string;
}

/**
 * Generate a document and hand it to the browser.
 *
 * Disabled states always carry a REASON. The button this replaces on the
 * payslip screen was `disabled` with `title="Download PDF (Coming soon)"`,
 * which told an employee nothing about whether it would ever work or who could
 * make it work — and it stayed that way for as long as it did partly because
 * nothing about it looked broken.
 */
export default function GenerateDocumentButton({
  documentType,
  employeeId,
  subjectId,
  params,
  locale,
  label = 'Download PDF',
  className,
  'data-testid': testId = 'generate-document',
}: GenerateDocumentButtonProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Three-state: `loaded` distinguishes "not fetched yet" from "off", so the
  // button does not flash disabled while branding is still in flight.
  const engineEnabled = useBrandingStore((s) => s.branding.document_engine_enabled);
  const brandingLoaded = useBrandingStore((s) => s.loaded);

  const unavailable = brandingLoaded && !engineEnabled;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await documentTemplateService.generateAndDownload({
        typeKey: documentType,
        employeeId,
        subjectId,
        params,
        locale,
      });
    } catch (err) {
      // Through the shared helper: axios rejects with a FLAT object, so
      // `err.response.data.message` is undefined here and the user would be
      // told "the operation could not be completed" instead of the real reason.
      setError(getApiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        data-testid={testId}
        onClick={() => void run()}
        disabled={busy || unavailable}
        title={
          unavailable
            ? 'PDF documents are not set up on this system yet. An administrator can turn them on in Settings.'
            : undefined
        }
        className={
          className ??
          'h-12 md:h-10 px-4 inline-flex items-center gap-2 rounded-[--radius-button] bg-brand-primary text-text-on-brand text-sm touch-manipulation disabled:opacity-50'
        }
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
        {busy ? 'Preparing…' : label}
      </button>
      {unavailable && (
        <span className="text-xs text-text-muted">
          PDF documents aren’t set up yet.
        </span>
      )}
      {error && (
        <span role="alert" className="text-xs text-red-700 max-w-xs">
          {error}
        </span>
      )}
    </div>
  );
}

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Loader2, Trash2, Upload } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import documentTemplateService from '@/services/documentTemplateService';
import { getApiErrorMessage } from '@/lib/apiError';
import { DocumentAssetSummary } from '@/types/document-template';

/**
 * Letterhead manager.
 *
 * The safe area is edited as four numbers in MILLIMETRES rather than by
 * dragging a box, and that is deliberate: millimetres are what the renderer
 * uses, what a printer understands, and what somebody can read off the artwork
 * their designer sent. A drag handle would be prettier and would give no way to
 * type in the number the design actually specifies.
 */
function LetterheadManager() {
  const [assets, setAssets] = useState<DocumentAssetSummary[]>([]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const objectUrls = useRef<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await documentTemplateService.listAssets('LETTERHEAD');
      setAssets(list);
      // Artwork is private, so a preview cannot be a bare <img src>. Each one
      // is fetched with the JWT attached and turned into an object URL.
      const urls: Record<string, string> = {};
      for (const a of list) {
        try {
          const url = await documentTemplateService.assetPreviewUrl(a.id);
          urls[a.id] = url;
          objectUrls.current.push(url);
        } catch {
          // A preview that cannot load must not take the page down with it.
        }
      }
      setPreviews(urls);
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const urls = objectUrls.current;
    return () => {
      // Revoked on unmount; the delay is for the same reason downloads use one.
      setTimeout(() => urls.forEach((u) => URL.revokeObjectURL(u)), 10_000);
    };
  }, [load]);

  const onUpload = async (file: File) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const created = await documentTemplateService.uploadAsset(file, {
        name: file.name.replace(/\.[^.]+$/, ''),
        scope: 'COMPANY',
        kind: 'LETTERHEAD',
      });
      // A warning is not a failure — a squarer letter pad is still usable, and
      // the tool should say so rather than refuse it.
      if (created.warning) setNotice(created.warning);
      await load();
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const onSafeArea = async (id: string, field: string, value: number) => {
    try {
      await documentTemplateService.updateAsset(id, { [field]: value });
      setAssets((prev) => prev.map((a) => (a.id === id ? { ...a, [field]: value } : a)));
    } catch (err) {
      setError(getApiErrorMessage(err));
    }
  };

  const onDelete = async (id: string) => {
    setError(null);
    try {
      const res = await documentTemplateService.deleteAsset(id);
      setNotice(res.message);
      await load();
    } catch (err) {
      setError(getApiErrorMessage(err));
    }
  };

  return (
    <div className="p-4 md:p-6 space-y-5" data-testid="letterhead-manager">
      <div className="flex items-center gap-2">
        <Link
          href="/dashboard/settings/documents"
          className="h-10 px-3 grid place-items-center rounded-[--radius-button] surface-panel border-surface-border border"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div>
          <h1 className="text-xl font-semibold text-text-heading">Company letterhead</h1>
          <p className="text-sm text-text-muted">
            Your printed stationery, and where text may sit on it. Documents are drawn on top of
            this artwork.
          </p>
        </div>
      </div>

      {/* A LABELLED BUTTON over a hidden input, plus a drop target.
          The bare `<input type="file">` this replaces rendered as the browser's
          own "Choose File — No file chosen" text, which reads as a caption
          rather than as a control: the first person to open this screen could
          not find the upload at all. */}
      <label
        htmlFor="letterhead-file"
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files?.[0];
          if (f) void onUpload(f);
        }}
        className={`block cursor-pointer rounded-[--radius-card] border-2 border-dashed p-8 text-center transition ${
          dragging ? 'border-brand-primary bg-brand-primary/5' : 'border-surface-border bg-surface-card'
        }`}
        data-testid="letterhead-dropzone"
      >
        <input
          ref={fileRef}
          id="letterhead-file"
          type="file"
          accept="image/png,image/jpeg"
          aria-label="Letterhead image"
          className="sr-only"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onUpload(f);
          }}
        />
        {busy ? (
          <p className="text-sm text-text-body flex items-center justify-center gap-2">
            <Loader2 className="h-5 w-5 animate-spin" /> Uploading…
          </p>
        ) : (
          <>
            <Upload className="mx-auto h-8 w-8 text-brand-primary" />
            <p className="mt-3 text-base font-medium text-text-heading">
              Upload your letter pad
            </p>
            <span className="mt-3 inline-flex h-11 items-center gap-2 rounded-[--radius-button] bg-brand-primary px-5 text-sm text-text-on-brand">
              <Upload className="h-4 w-4" />
              Choose an image
            </span>
            <p className="mt-3 text-xs text-text-muted">
              or drag it here · PNG or JPEG, <strong>1240 × 1754</strong> or larger (A4 at 150 DPI)
            </p>
            <p className="mt-1 text-xs text-text-muted">
              PDF and SVG letterheads are not supported — export your pad as an image first.
            </p>
          </>
        )}
      </label>

      {error && (
        <div role="alert" className="rounded-[--radius-card] border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-[--radius-card] border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          {notice}
        </div>
      )}

      {loading && <p className="text-sm text-text-muted">Loading…</p>}

      {!loading && assets.length === 0 && (
        <p className="text-sm text-text-muted text-center">
          No letter pad uploaded yet — documents currently use a header built from your branding.
        </p>
      )}

      <ul className="grid gap-4 md:grid-cols-2">
        {assets.map((a) => (
          <li key={a.id} className="rounded-[--radius-card] bg-surface-card border-surface-border border p-4 space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium text-text-heading truncate">{a.name}</p>
                <p className="text-xs text-text-muted">
                  {a.widthPx}×{a.heightPx} · {(a.fileSize / 1024).toFixed(0)} KB ·{' '}
                  {a.scope === 'COMPANY' ? 'Company-wide' : a.branchName}
                  {!a.isActive && ' · retired'}
                </p>
              </div>
              <button
                type="button"
                aria-label={`Delete ${a.name}`}
                onClick={() => void onDelete(a.id)}
                className="h-9 w-9 grid place-items-center rounded surface-panel border border-surface-border"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>

            <div className="relative bg-white border border-surface-border rounded overflow-hidden" style={{ aspectRatio: '210 / 297' }}>
              {previews[a.id] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={previews[a.id]} alt="" className="absolute inset-0 w-full h-full object-contain" />
              ) : (
                <div className="absolute inset-0 grid place-items-center text-xs text-text-muted">
                  Preview unavailable
                </div>
              )}
              {/* The safe area, drawn to scale over the artwork — this is what
                  stops somebody putting body text on top of their own logo. */}
              <div
                className="absolute border-2 border-dashed border-brand-primary/60 pointer-events-none"
                style={{
                  top: `${(a.safeTopMm / 297) * 100}%`,
                  bottom: `${(a.safeBottomMm / 297) * 100}%`,
                  left: `${(a.safeLeftMm / 210) * 100}%`,
                  right: `${(a.safeRightMm / 210) * 100}%`,
                }}
              />
            </div>

            <fieldset className="grid grid-cols-2 gap-2">
              <legend className="text-xs text-text-muted mb-1">Where text may go (mm)</legend>
              {(
                [
                  ['Top', 'safeTopMm'],
                  ['Bottom', 'safeBottomMm'],
                  ['Left', 'safeLeftMm'],
                  ['Right', 'safeRightMm'],
                ] as const
              ).map(([label, field]) => (
                <label key={field} className="text-xs space-y-1">
                  <span className="text-text-muted">{label}</span>
                  <input
                    type="number"
                    min={0}
                    max={120}
                    aria-label={`${label} margin in millimetres`}
                    value={a[field]}
                    onChange={(e) => void onSafeArea(a.id, field, Number(e.target.value))}
                    className="w-full h-10 px-2 rounded-[--radius-input] surface-panel border-surface-border border"
                  />
                </label>
              ))}
            </fieldset>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function Page() {
  return (
    <ProtectedRoute requiredPermission="MANAGE_DOCUMENT_TEMPLATES">
      <LetterheadManager />
    </ProtectedRoute>
  );
}

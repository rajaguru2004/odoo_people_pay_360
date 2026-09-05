'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Paperclip, Upload, Loader2, Trash2, FileText, Download } from 'lucide-react';
import { useTranslations } from 'next-intl';
import taskService from '@/services/taskService';
import vaultService from '@/services/vaultService';
import { apiErrorMessage } from '@/utils/apiError';
import { resolveFileUrl } from '@/utils/fileUrl';

/**
 * Where an attachment's bytes actually live, and therefore how to fetch them.
 *
 * R53 moved task attachments onto the PRIVATE storage door. A private object's
 * `fileUrl` is a `private://…` ref — deliberately not a URL, and nothing may
 * render it — so the row this component used to hang on `<a href>` became a
 * dead link the moment the fix landed. The serialiser answers the question for
 * us: `downloadUrl` is `/secure-files/task-attachment/:id` for a private row and
 * the row's own public `fileUrl` for one uploaded before the change.
 *
 * The `/secure-files` route is authorised on project membership, and the JWT
 * lives in local storage — so a plain tab navigation carries no `Authorization`
 * header and answers 401. It has to go through axios and come back as bytes,
 * exactly as `vaultService.download` already does for every other private file
 * in the app.
 *
 * `private://` is checked too, so a client talking to a server that predates
 * the `downloadUrl` field still takes the authenticated path rather than
 * rendering a ref as a link.
 */
function needsAuthorisedFetch(ref?: string | null): boolean {
  return (
    typeof ref === 'string' &&
    (ref.startsWith('/secure-files/') || ref.startsWith('private://'))
  );
}

function humanSize(n?: number) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function TaskAttachments({ taskId }: { taskId: string }) {
  const t = useTranslations('taskAttachments');
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = (await taskService.getAttachments(taskId)) as any;
      setItems(res.data || []);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [taskId]);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      await taskService.uploadAttachment(taskId, file);
      await load();
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const del = async (id: string) => { await taskService.deleteAttachment(id); await load(); };

  /**
   * Fetch a private attachment through the route that is allowed to serve it.
   *
   * The kind/id pair rebuilds the same `/secure-files/task-attachment/:id` the
   * payload named; `vaultService.download` is what turns it into a saved file,
   * and reusing it is deliberate — a second copy of the blob/object-URL dance
   * is a second place to get the revoke timing wrong.
   *
   * A failure here is a 403 or a 404 and has to be visible: silently doing
   * nothing is indistinguishable from a slow network, which is how a dead
   * download link survives a release.
   */
  const download = async (a: any) => {
    setDownloadingId(a.id);
    setError(null);
    try {
      await vaultService.download('task-attachment', a.id, a.fileName);
    } catch (e) {
      setError(apiErrorMessage(e, t('downloadFailed')));
    } finally {
      setDownloadingId(null);
    }
  };

  return (
    <div>
      {/* Section header — icon + title + upload button */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Paperclip className="h-4 w-4 text-brand-primary" />
          <h3 className="text-sm font-semibold text-text-heading">{t('heading')}</h3>
        </div>
        <input ref={fileRef} type="file" data-testid="attachment-input" className="hidden" onChange={onFile} />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          data-testid="attachment-upload"
          className="flex items-center gap-1.5 rounded-[--radius-button] border border-surface-border bg-surface-card px-3 py-1.5 text-xs font-medium text-text-body hover:bg-surface-page disabled:opacity-60">
          {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          {t('uploadBtn')}
        </button>
      </div>

      {/* File list */}
      {loading ? (
        <Loader2 className="mx-auto h-5 w-5 animate-spin text-text-muted" />
      ) : items.length === 0 ? (
        <p data-testid="attachment-empty" className="text-sm text-text-muted">{t('emptyNoAttachments')}</p>
      ) : (
        <div className="space-y-2">
          {error && (
            <p data-testid="attachment-error" className="text-xs text-status-error">{error}</p>
          )}
          {items.map((a) => (
            <div key={a.id} data-testid={`attachment-row-${a.id}`}
              className="flex items-center justify-between rounded-[--radius-button] border border-surface-border bg-surface-card px-3 py-2">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 shrink-0 text-text-muted" />
                <div>
                  <p className="text-sm text-text-body">{a.fileName}</p>
                  <p className="text-xs text-text-muted">{humanSize(a.fileSize)}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {(() => {
                  const ref = a.downloadUrl ?? a.url ?? a.fileUrl;
                  if (!ref) return null;
                  if (needsAuthorisedFetch(ref)) {
                    return (
                      <button
                        onClick={() => download(a)}
                        disabled={downloadingId === a.id}
                        title={t('downloadBtn')}
                        aria-label={t('downloadBtn')}
                        data-testid={`attachment-download-${a.id}`}
                        className="text-text-muted hover:text-brand-primary disabled:opacity-60"
                      >
                        {downloadingId === a.id
                          ? <Loader2 className="h-4 w-4 animate-spin" />
                          : <Download className="h-4 w-4" />}
                      </button>
                    );
                  }
                  // A row uploaded before R53: an ordinary public URL, which a
                  // plain link still serves correctly.
                  return (
                    <a
                      href={resolveFileUrl(ref) ?? ref}
                      target="_blank"
                      rel="noreferrer"
                      title={t('downloadBtn')}
                      aria-label={t('downloadBtn')}
                      data-testid={`attachment-download-${a.id}`}
                      className="text-text-muted hover:text-brand-primary"
                    >
                      <Download className="h-4 w-4" />
                    </a>
                  );
                })()}
                <button onClick={() => del(a.id)} data-testid={`attachment-delete-${a.id}`} className="text-text-muted hover:text-status-error">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

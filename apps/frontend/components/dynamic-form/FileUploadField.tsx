'use client';

import { useRef, useState } from 'react';
import { Image as ImageIcon, Link2, Loader2, Paperclip, Trash2, Upload } from 'lucide-react';
import uploadService, { UploadFolder } from '@/services/uploadService';
import { resolveFileUrl } from '@/utils/fileUrl';
import { getApiErrorMessage } from '@/lib/apiError';
import { toast } from '@/lib/toast';

/**
 * The control behind a template FILE field.
 *
 * The field STORES a URL — that has not changed, and is what keeps a file field
 * cheap (no new table, no lifecycle). What changed is that a user no longer has
 * to produce that URL themselves: the old renderer showed a text box with the
 * placeholder "URL", which asked someone filling in an employee's photo to go
 * find a hosting service first. Uploading writes to storage and puts the
 * returned URL in the same form value, so nothing downstream knows the
 * difference.
 *
 * Pasting a URL is still possible, behind a toggle, because some records really
 * do point at a file that already lives somewhere else.
 */

export interface FileUploadFieldProps {
  value: string;
  onChange: (next: string) => void;
  /** Photo fields get an avatar preview; everything else gets a file chip. */
  variant?: 'image' | 'file';
  folder?: UploadFolder;
  disabled?: boolean;
  hasError?: boolean;
  /** Shown inside the empty dropzone. */
  hint?: string;
}

const ACCEPT: Record<'image' | 'file', string> = {
  image: 'image/png,image/jpeg,image/webp,image/svg+xml',
  file: 'image/png,image/jpeg,application/pdf,.doc,.docx',
};

const MAX_BYTES: Record<'image' | 'file', number> = {
  image: 5 * 1024 * 1024,
  file: 10 * 1024 * 1024,
};

export function FileUploadField({
  value,
  onChange,
  variant = 'file',
  folder,
  disabled,
  hasError,
  hint,
}: FileUploadFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [urlMode, setUrlMode] = useState(false);

  const resolved = resolveFileUrl(value);
  const targetFolder: UploadFolder =
    folder ?? (variant === 'image' ? 'profile' : 'documents');

  const upload = async (file: File) => {
    // Checked here as well as on the server so the common mistake costs a
    // toast rather than a round trip with a multi-megabyte body.
    if (file.size > MAX_BYTES[variant]) {
      toast.error(
        `File is too large. Maximum ${Math.round(MAX_BYTES[variant] / (1024 * 1024))}MB.`,
      );
      return;
    }
    setBusy(true);
    try {
      const res: any = await uploadService.uploadFile(file, targetFolder);
      const url = res?.url ?? res?.data?.url;
      if (!url) throw new Error('The server did not return a file URL');
      onChange(url);
    } catch (error) {
      toast.error(getApiErrorMessage(error, 'Upload failed'));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (disabled || busy) return;
    const file = e.dataTransfer.files?.[0];
    if (file) upload(file);
  };

  if (urlMode) {
    return (
      <div className="space-y-2">
        <input
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          readOnly={disabled}
          placeholder="https://…"
          className={`w-full px-4 py-2 border rounded-[--radius-input] focus:outline-none focus:ring-2 focus:ring-brand-primary/20 bg-surface-card text-text-body ${
            hasError ? 'border-status-error' : 'border-surface-border'
          }`}
        />
        <button
          type="button"
          onClick={() => setUrlMode(false)}
          className="text-xs text-brand-primary hover:underline"
        >
          Upload a file instead
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT[variant]}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) upload(file);
        }}
      />

      {value ? (
        <div className="flex items-center gap-3 rounded-[--radius-input] border border-surface-border bg-surface-page p-3">
          {variant === 'image' && resolved ? (
            <img
              src={resolved}
              alt="Preview"
              className="h-16 w-16 shrink-0 rounded-full border border-surface-border object-cover"
            />
          ) : (
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-card text-text-muted">
              <Paperclip size={16} />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <a
              href={resolved ?? '#'}
              target="_blank"
              rel="noreferrer"
              className="block truncate text-sm text-brand-primary hover:underline"
            >
              {value.split('/').pop() || value}
            </a>
            <p className="mt-0.5 text-xs text-text-muted">Stored and linked</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              disabled={disabled || busy}
              onClick={() => inputRef.current?.click()}
              className="rounded-lg px-2 py-1 text-xs text-text-muted hover:bg-surface-card hover:text-text-heading disabled:opacity-50"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : 'Replace'}
            </button>
            {!disabled && (
              <button
                type="button"
                onClick={() => onChange('')}
                aria-label="Remove file"
                className="rounded-lg p-1.5 text-text-muted hover:bg-status-error/10 hover:text-status-error"
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        </div>
      ) : (
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`flex w-full flex-col items-center justify-center gap-2 rounded-[--radius-input] border-2 border-dashed px-4 py-6 text-center transition-colors disabled:opacity-60 ${
            dragging
              ? 'border-brand-primary bg-brand-primary/5'
              : hasError
                ? 'border-status-error'
                : 'border-surface-border hover:border-brand-primary hover:bg-surface-page'
          }`}
        >
          {busy ? (
            <Loader2 size={20} className="animate-spin text-brand-primary" />
          ) : variant === 'image' ? (
            <ImageIcon size={20} className="text-text-muted" />
          ) : (
            <Upload size={20} className="text-text-muted" />
          )}
          <span className="text-sm text-text-body">
            {busy ? 'Uploading…' : 'Click to upload, or drop a file here'}
          </span>
          <span className="text-xs text-text-muted">
            {hint ??
              (variant === 'image'
                ? 'PNG, JPG, WebP or SVG · up to 5MB'
                : 'PDF, image or Word document · up to 10MB')}
          </span>
        </button>
      )}

      {!disabled && (
        <button
          type="button"
          onClick={() => setUrlMode(true)}
          className="flex items-center gap-1 text-xs text-text-muted hover:text-brand-primary"
        >
          <Link2 size={12} /> Use a link instead
        </button>
      )}
    </div>
  );
}

export default FileUploadField;

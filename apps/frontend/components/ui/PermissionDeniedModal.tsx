'use client';

import { useEffect, useState } from 'react';
import { ShieldOff, X } from 'lucide-react';
import { registerPermissionErrorHandler } from '@/lib/permissionError';

export default function PermissionDeniedModal() {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    registerPermissionErrorHandler((msg) => {
      setMessage(msg);
      setOpen(true);
    });
  }, []);

  if (!open) return null;

  return (
    <div
      data-testid="permission-denied-modal"
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Permission denied"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={() => setOpen(false)}
      />

      {/* Panel */}
      <div className="relative z-10 w-full max-w-sm rounded-[--radius-card] border border-surface-border bg-surface-card shadow-xl">
        {/* Close */}
        <button
          onClick={() => setOpen(false)}
          className="absolute right-3 top-3 rounded-[--radius-button] p-1 text-text-muted hover:bg-surface-hover hover:text-text-body"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="flex flex-col items-center gap-4 px-6 py-8 text-center">
          {/* Icon */}
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-status-error/10">
            <ShieldOff className="h-7 w-7 text-status-error" />
          </div>

          {/* Text */}
          <div className="space-y-1.5">
            <h2 className="text-lg font-semibold text-text-heading">
              Access Denied
            </h2>
            <p className="text-sm leading-relaxed text-text-muted">
              {message || "You don't have permission to perform this action."}
            </p>
          </div>

          {/* CTA */}
          <button
            onClick={() => setOpen(false)}
            className="mt-1 w-full rounded-[--radius-button] bg-brand-primary px-4 py-2 text-sm font-medium text-text-on-brand hover:bg-brand-primary-dark"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

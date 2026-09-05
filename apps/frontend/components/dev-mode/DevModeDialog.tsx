'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, Terminal, X } from 'lucide-react';
import devModeService from '@/services/devModeService';
import { useDevModeStore } from '@/store/devModeStore';

interface Props {
  open: boolean;
  onClose: () => void;
  onUnlocked?: () => void;
}

/**
 * Password prompt for developer mode.
 *
 * The error text is deliberately flat and identical for every failure — a wrong
 * password, an unconfigured backend and a rate-refused attempt all read the
 * same. An admin probing the dialog should learn nothing about whether the
 * hidden surface is even installed.
 */
export default function DevModeDialog({ open, onClose, onUnlocked }: Props) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const elevate = useDevModeStore((s) => s.elevate);

  useEffect(() => {
    if (open) {
      setPassword('');
      setError('');
      // Focus after paint, or the autofocus lands before the panel exists.
      const id = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(id);
    }
  }, [open]);

  if (!open) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !password) return;

    setBusy(true);
    setError('');
    try {
      const res = await devModeService.elevate(password);
      elevate(res.data.devToken, res.data.expiresAt);
      setPassword('');
      onUnlocked?.();
      onClose();
    } catch {
      setError('Incorrect password.');
      setPassword('');
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Developer mode"
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      <div className="relative z-10 w-full max-w-sm rounded-[--radius-card] border border-surface-border bg-surface-card shadow-xl">
        <button
          onClick={onClose}
          className="absolute right-3 top-3 rounded-[--radius-button] p-1 text-text-muted hover:bg-surface-hover hover:text-text-body"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>

        <form onSubmit={submit} className="flex flex-col gap-4 px-6 py-8">
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-primary/10">
              <Terminal className="h-7 w-7 text-brand-primary" />
            </div>
            <div className="space-y-1.5">
              <h2 className="text-lg font-semibold text-text-heading">Developer mode</h2>
              <p className="text-sm leading-relaxed text-text-muted">
                Enter the developer password to unlock operator settings for this tab.
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <input
              ref={inputRef}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="off"
              placeholder="Developer password"
              className="w-full rounded-[--radius-button] border border-surface-border bg-surface-page px-3 py-2 text-sm text-text-body outline-none focus:border-brand-primary"
            />
            {error && <p className="text-xs text-status-error">{error}</p>}
          </div>

          <button
            type="submit"
            disabled={busy || !password}
            className="flex w-full items-center justify-center gap-2 rounded-[--radius-button] bg-brand-primary px-4 py-2 text-sm font-medium text-text-on-brand hover:bg-brand-primary-dark disabled:opacity-50"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Unlock
          </button>

          <p className="text-center text-[11px] leading-relaxed text-text-muted">
            Access ends when this tab is closed or reloaded.
          </p>
        </form>
      </div>
    </div>
  );
}

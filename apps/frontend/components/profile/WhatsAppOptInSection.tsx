'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, MessageCircle, ShieldCheck, X } from 'lucide-react';
import { toast } from 'sonner';
import whatsappService from '@/services/whatsappService';
import { MyWhatsAppStatus, OptInPreview } from '@/types/whatsapp';

const inputCls =
  'w-full h-10 px-3 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/30 transition-all';

/**
 * Employee self-service opt-in for WhatsApp HR notifications.
 *
 * Two steps on purpose. The server normalises whatever the employee types into
 * E.164 and shows it back for confirmation before any consent is recorded — so
 * a mis-parsed number becomes a visible correction rather than a message
 * delivered to a stranger who happens to own the resulting number.
 */
export default function WhatsAppOptInSection() {
  const [status, setStatus] = useState<MyWhatsAppStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [phone, setPhone] = useState('');
  const [preview, setPreview] = useState<OptInPreview | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const res = await whatsappService.me();
      setStatus(res.data ?? null);
    } catch {
      /* the section simply stays empty if the channel is unavailable */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  async function runPreview() {
    if (!phone.trim()) return;
    setBusy(true);
    try {
      const res = await whatsappService.previewOptIn(phone.trim());
      setPreview(res.data ?? null);
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? 'Could not check that number');
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!preview) return;
    setBusy(true);
    try {
      const res = await whatsappService.confirmOptIn(preview.phoneE164);
      setStatus(res.data ?? null);
      setPreview(null);
      setPhone('');
      toast.success('WhatsApp updates enabled');
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? 'Could not enable WhatsApp updates');
    } finally {
      setBusy(false);
    }
  }

  async function optOut() {
    setBusy(true);
    try {
      const res = await whatsappService.optOut();
      setStatus(res.data ?? null);
      toast.success('WhatsApp updates stopped');
    } catch {
      toast.error('Could not stop WhatsApp updates');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white p-5 text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  const active = status?.optedIn && status?.verified;

  return (
    <div id="notifications" className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="mb-4 flex items-start gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-primary/10 text-brand-primary">
          <MessageCircle className="h-5 w-5" />
        </div>
        <div>
          <h3 className="font-semibold text-slate-800">WhatsApp updates</h3>
          <p className="text-sm text-slate-500">
            Get leave decisions, approvals and document-expiry reminders on WhatsApp.
          </p>
        </div>
      </div>

      {status?.optedIn ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>
              Updates are on for <span className="font-medium">{status.phoneMasked}</span>
              {!status.verified && ' — pending verification of this number'}
            </span>
          </div>
          {!active && (
            <p className="flex items-start gap-2 text-xs text-amber-700">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              We could not yet confirm this number on WhatsApp, so nothing will be delivered until
              it is verified.
            </p>
          )}
          <button
            type="button"
            onClick={optOut}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
            Stop WhatsApp updates
          </button>
        </div>
      ) : preview ? (
        <div className="space-y-3">
          <div className="rounded-lg bg-slate-50 p-4">
            <p className="text-sm text-slate-500">Send WhatsApp updates to</p>
            <p className="mt-1 font-mono text-lg font-semibold text-slate-800">
              {preview.phoneE164}
            </p>

            {preview.alreadyLinkedToAnotherUser && (
              <p className="mt-2 flex items-start gap-2 text-xs text-rose-700">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                This number is already linked to another account and cannot be used.
              </p>
            )}
            {preview.existsOnWhatsApp === false && (
              <p className="mt-2 flex items-start gap-2 text-xs text-rose-700">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                This number is not registered on WhatsApp.
              </p>
            )}
            {preview.existsOnWhatsApp === null && (
              <p className="mt-2 text-xs text-slate-400">
                We could not check this number right now — we will confirm it shortly.
              </p>
            )}
          </div>

          <p className="text-xs text-slate-500">
            Check the number carefully — messages will go to whoever owns it.
          </p>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPreview(null)}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
            >
              Change number
            </button>
            <button
              type="button"
              onClick={confirm}
              disabled={
                busy || preview.alreadyLinkedToAnotherUser || preview.existsOnWhatsApp === false
              }
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-primary px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ShieldCheck className="h-4 w-4" />
              )}
              Yes, this is my number
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex gap-2">
            <input
              className={inputCls}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && runPreview()}
              placeholder={status?.hasProfilePhone ? status.profilePhoneMasked : '+968 9001 0000'}
            />
            <button
              type="button"
              onClick={runPreview}
              disabled={busy || !phone.trim()}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-brand-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Continue
            </button>
          </div>
          <p className="text-xs text-slate-400">
            Include your country code. We will show you the number back to check before switching
            anything on.
          </p>
        </div>
      )}
    </div>
  );
}

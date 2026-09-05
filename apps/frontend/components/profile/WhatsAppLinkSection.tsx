'use client';

import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  Loader2,
  MessagesSquare,
  Unlink,
} from 'lucide-react';
import { toast } from 'sonner';
import whatsappService from '@/services/whatsappService';
import { MyWhatsAppStatus } from '@/types/whatsapp';

const inputCls =
  'w-full h-10 px-3 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/30 transition-all';

/**
 * Linking a handset so it can DO things, not merely receive them.
 *
 * Deliberately separate from the opt-in section above it, because they are two
 * different decisions: opting in is consent to be messaged, linking is proof of
 * identity. Somebody may reasonably want the first without the second.
 *
 * The code is sent to WhatsApp and typed back HERE, in an authenticated
 * browser. That direction is the whole security property — closing the loop on
 * the web means somebody holding only the SIM cannot link a number, and
 * somebody holding only a stolen session cannot either.
 *
 * Renders nothing at all when the channel is off, rather than offering buttons
 * that answer "not switched on".
 */
export default function WhatsAppLinkSection() {
  const [status, setStatus] = useState<MyWhatsAppStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [phone, setPhone] = useState('');
  const [enrollmentId, setEnrollmentId] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState('');
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');

  const load = async () => {
    try {
      const res = await whatsappService.me();
      setStatus(res.data ?? null);
    } catch {
      /* stays hidden if the channel is unavailable */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const fail = (e: any, fallback: string) =>
    toast.error(e?.response?.data?.message ?? fallback);

  async function start() {
    if (!phone.trim()) return;
    setBusy(true);
    try {
      const res = await whatsappService.enrollStart(phone.trim());
      setEnrollmentId(res.data?.enrollmentId ?? null);
      setSentTo(res.data?.phoneMasked ?? '');
      toast.success('Code sent. Check WhatsApp.');
    } catch (e) {
      fail(e, 'Could not send a code to that number');
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    if (!enrollmentId || code.trim().length < 4) return;
    setBusy(true);
    try {
      const res = await whatsappService.enrollVerify(enrollmentId, code.trim());
      setStatus(res.data ?? null);
      setEnrollmentId(null);
      setCode('');
      toast.success('Linked. You can now use HR services on WhatsApp.');
    } catch (e) {
      fail(e, 'That code was not accepted');
    } finally {
      setBusy(false);
    }
  }

  async function savePin() {
    if (!/^\d{4,8}$/.test(pin)) {
      toast.error('Use 4 to 8 digits.');
      return;
    }
    setBusy(true);
    try {
      await whatsappService.setPin(pin);
      setPin('');
      await load();
      toast.success('PIN saved.');
    } catch (e) {
      fail(e, 'Could not save that PIN');
    } finally {
      setBusy(false);
    }
  }

  async function unlink() {
    setBusy(true);
    try {
      const res = await whatsappService.unlink();
      setStatus(res.data ?? null);
      toast.success('Handset unlinked.');
    } catch (e) {
      fail(e, 'Could not unlink');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return null;
  // Nothing to offer if the admin has not switched two-way on.
  if (!status?.enrollmentEnabled || !status?.inboundEnabled) return null;

  const active = status.status === 'ACTIVE';

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
          <MessagesSquare className="h-5 w-5" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-slate-800">Use HR services on WhatsApp</h3>
          <p className="text-xs text-slate-500">
            Check in, book leave and see your payslips by messaging HR.
          </p>
        </div>
      </div>

      {active ? (
        <div className="space-y-4">
          <p className="flex items-center gap-2 text-sm text-emerald-700">
            <CheckCircle2 className="h-4 w-4" />
            {status.phoneMasked} is linked. Message HR and reply <strong>MENU</strong>.
          </p>

          {status.requirePinForSensitive && (
            <div className="rounded-lg border border-slate-200 p-3">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-700">
                <KeyRound className="h-4 w-4" />
                {status.pinSet ? 'Change your PIN' : 'Set a PIN'}
              </div>
              <p className="mb-3 text-xs text-slate-500">
                {status.pinSet
                  ? 'Asked for before pay details are shown on WhatsApp.'
                  : 'Pay details will not be shown on WhatsApp until you set one.'}
              </p>
              <div className="flex gap-2">
                <input
                  className={inputCls}
                  type="password"
                  inputMode="numeric"
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
                  onKeyDown={(e) => e.key === 'Enter' && savePin()}
                  placeholder="4 to 8 digits"
                />
                <button
                  type="button"
                  onClick={savePin}
                  disabled={busy || pin.length < 4}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-brand-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Save
                </button>
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={unlink}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            <Unlink className="h-4 w-4" />
            Unlink this handset
          </button>
        </div>
      ) : enrollmentId ? (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            We sent a code to {sentTo}. Type it here to finish linking.
          </p>
          <div className="flex gap-2">
            <input
              className={inputCls}
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
              onKeyDown={(e) => e.key === 'Enter' && verify()}
              placeholder="6-digit code"
            />
            <button
              type="button"
              onClick={verify}
              disabled={busy || code.trim().length < 4}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-brand-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Link
            </button>
          </div>
          <button
            type="button"
            onClick={() => {
              setEnrollmentId(null);
              setCode('');
            }}
            className="text-xs text-slate-400 hover:text-slate-600"
          >
            Use a different number
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {status.status === 'REVOKED' && (
            <p className="flex items-start gap-2 text-xs text-amber-700">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              This handset was unlinked. Link it again to use HR services on WhatsApp.
            </p>
          )}
          <div className="flex gap-2">
            <input
              className={inputCls}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && start()}
              placeholder={status.hasProfilePhone ? status.profilePhoneMasked : '+968 9001 0000'}
            />
            <button
              type="button"
              onClick={start}
              disabled={busy || !phone.trim()}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-brand-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Send me a code
            </button>
          </div>
          <p className="text-xs text-slate-400">
            We send a code to WhatsApp and you type it back here. Doing it this way round means
            somebody who only has your phone cannot link it.
          </p>
        </div>
      )}
    </div>
  );
}

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Copy, Loader2, Link2, Send, Unlink } from 'lucide-react';
import { toast } from 'sonner';
import telegramService from '@/services/telegramService';
import { apiErrorMessage } from '@/utils/apiError';
import { MyTelegramStatus, TelegramLinkCode } from '@/types/telegram';

/**
 * Employee self-service Telegram link.
 *
 * The chat id is never typed in here, for the reason the Discord section gives:
 * an id claimed in a form is an id anyone could claim, and the prize is somebody
 * else's HR notifications. The browser issues a one-time code and Telegram
 * redeems it, so the id is *learned* from the update the bot receives rather
 * than asserted by the person filling in the field.
 */
export default function TelegramLinkSection() {
  const [status, setStatus] = useState<MyTelegramStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<TelegramLinkCode | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await telegramService.me();
      setStatus(res.data ?? null);
      return res.data ?? null;
    } catch {
      // The section stays hidden if the channel is unavailable.
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // While a code is live, poll so the screen flips to "linked" the moment the
  // employee sends /link — without asking them to come back and refresh.
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!code || secondsLeft <= 0) return;

    pollRef.current = setInterval(async () => {
      const next = await load();
      if (next?.linked) {
        setCode(null);
        setSecondsLeft(0);
        toast.success('Telegram account linked');
      }
    }, 5000);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [code, secondsLeft, load]);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const t = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [secondsLeft]);

  async function issueCode() {
    setBusy(true);
    try {
      const res = await telegramService.startLink();
      setCode(res.data ?? null);
      setSecondsLeft((res.data?.expiresInMinutes ?? 15) * 60);
    } catch (e) {
      // Through apiErrorMessage, never err.response.data.message: the axios
      // interceptor rejects with a FLAT object, so the natural-looking read is
      // undefined and a precise refusal reaches the user as a generic failure.
      toast.error(apiErrorMessage(e, 'Could not create a link code'));
    } finally {
      setBusy(false);
    }
  }

  async function unlink() {
    setBusy(true);
    try {
      await telegramService.unlink();
      await load();
      setCode(null);
      toast.success('Telegram account unlinked');
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not unlink Telegram'));
    } finally {
      setBusy(false);
    }
  }

  function copyCommand() {
    if (!code) return;
    void navigator.clipboard.writeText(`/link ${code.code}`);
    toast.success('Command copied');
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white p-5 text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  if (!status?.available) return null;

  const mmss = `${String(Math.floor(secondsLeft / 60)).padStart(2, '0')}:${String(
    secondsLeft % 60,
  ).padStart(2, '0')}`;

  return (
    <div id="telegram" className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="mb-4 flex items-start gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-sky-50 text-sky-600">
          <Send className="h-5 w-5" />
        </div>
        <div>
          <h3 className="font-semibold text-slate-800">Telegram</h3>
          <p className="text-sm text-slate-500">
            Link your Telegram account to receive HR updates as messages from the company bot.
          </p>
        </div>
      </div>

      {status.linked ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>
              Linked to{' '}
              <span className="font-medium">
                {status.username ? `@${status.username}` : 'your account'}
              </span>
            </span>
          </div>

          <div>
            <label className="text-xs font-medium text-slate-500">Telegram chat ID</label>
            <input
              readOnly
              value={status.telegramChatId ?? ''}
              className="mt-1 w-full cursor-default rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-sm text-slate-700"
            />
            <p className="mt-1 text-xs text-slate-400">
              Set by Telegram when you sent <code>/link</code>. It cannot be typed in — that is what
              stops someone else&apos;s chat being entered here.
            </p>
          </div>

          <button
            type="button"
            onClick={unlink}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unlink className="h-4 w-4" />}
            Unlink Telegram
          </button>
        </div>
      ) : code && secondsLeft > 0 ? (
        <div className="space-y-3">
          <div className="rounded-lg bg-slate-50 p-4">
            <p className="text-sm text-slate-500">Start a chat with the company bot and send</p>
            <p className="mt-1 font-mono text-2xl font-semibold tracking-wider text-slate-800">
              /link {code.code}
            </p>
            <p className="mt-2 text-xs text-slate-400">Expires in {mmss}</p>
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={copyCommand}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
            >
              <Copy className="h-4 w-4" />
              Copy command
            </button>
            <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Waiting for you to send it…
            </span>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <button
            type="button"
            onClick={issueCode}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
            Get link code
          </button>
          <p className="text-xs text-slate-400">
            You will get a six-digit code to send as <code>/link &lt;code&gt;</code> to the bot.
            {status.status === 'REVOKED' && ' Your previous link was removed.'}
          </p>
        </div>
      )}
    </div>
  );
}

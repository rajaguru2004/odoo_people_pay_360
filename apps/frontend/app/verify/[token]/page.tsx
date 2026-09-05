'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, MapPin, ShieldCheck } from 'lucide-react';
import { getCurrentCoords } from '@/lib/geolocation';
import WebcamCapture from '@/components/face-recognition/WebcamCapture';
import { API_BASE as SHARED_API_BASE } from '@/lib/apiBase';

/**
 * The browser half of a verified attendance punch, for any chat channel.
 *
 * Deliberately outside /dashboard and outside the auth layout: the employee
 * arrives from a phone that has no HR session, and the one-time token in the
 * URL is the credential. Nothing is fetched about them and nothing identifying
 * is shown before the punch succeeds — a link in a chat is not private, and the
 * page must not become a way to find out whose link it is.
 *
 * What it asks for comes from the server, not the URL: `requires.face` and
 * `requires.location` are decided by the row that minted the token.
 */

type Phase = 'checking' | 'invalid' | 'ready' | 'submitting' | 'done' | 'error';

type InvalidReason = 'expired' | 'used' | 'replaced' | 'unknown';

/**
 * One sentence per cause. They used to share "expired or already used", which
 * is actively misleading for a link that was replaced while still live — the
 * fix is to open the newest message, not to wait or ask for another.
 */
const INVALID_TEXT: Record<InvalidReason, string> = {
  expired: 'This link has expired.',
  used: 'This link has already been used.',
  replaced: 'A newer link was sent, so this one is no longer active.',
  unknown: 'This link is not valid.',
};

interface Requires {
  face: boolean;
  location: boolean;
}

// Plain fetch rather than the axios instance: that one carries an auth token
// and a 401 interceptor, and this page has neither a session nor anywhere to
// redirect to.
//
// RELATIVE, not NEXT_PUBLIC_API_URL, on purpose. This page is opened on a
// phone from a chat link, so whatever host served the page is by definition
// reachable — while the configured API base is usually a localhost the phone
// cannot see. A fallback rewrite in next.config.ts proxies these paths to the
// backend, so same-origin works in every environment the page can load in.
// Resolved centrally: this page is opened on a handset, from a link, with no
// session — a wrong base here is a dead link, not a retryable error.
const API_BASE = SHARED_API_BASE;

// ngrok's free tier answers browser-looking requests with an HTML interstitial
// unless this header is present. Harmless on every other host.
const FETCH_HEADERS = { 'ngrok-skip-browser-warning': 'true' };

export default function ChannelVerifyPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);

  const [phase, setPhase] = useState<Phase>('checking');
  const [invalidReason, setInvalidReason] = useState<InvalidReason>('unknown');
  const [requires, setRequires] = useState<Requires>({ face: false, location: false });
  const [label, setLabel] = useState('Continue');
  const [message, setMessage] = useState('');
  const [doneAt, setDoneAt] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(false);
  const [insecure, setInsecure] = useState(false);

  /**
   * The position, requested as soon as the page is usable and held.
   *
   * enableHighAccuracy is slow on a cold phone, and making somebody wait for a
   * fix AFTER they have taken a photo is the worst possible ordering — the
   * capability is single-use, so the photo and the position have to go in one
   * request either way.
   */
  const coordsRef = useRef<Promise<{ latitude: number; longitude: number; accuracy?: number }> | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/channel/verify/${token}`, {
          headers: FETCH_HEADERS,
        });
        const body = await res.json();
        if (cancelled) return;

        const data = body?.data;
        if (!data?.valid) {
          // Keep WHY: "expired" for a link whose own expiry had not arrived was
          // what made this look broken rather than merely stale.
          setInvalidReason(data?.reason ?? 'unknown');
          setPhase('invalid');
          return;
        }

        setRequires(data.requires ?? { face: false, location: false });
        setLabel(data.purposeLabel || 'Continue');

        // getUserMedia needs a secure context. If the portal URL is a plain
        // http LAN address the camera silently never opens, which reads as a
        // broken page rather than a misconfiguration.
        if (data.requires?.face && typeof window !== 'undefined' && !window.isSecureContext) {
          setInsecure(true);
        }

        if (data.requires?.location) {
          coordsRef.current = getCurrentCoords();
          // Swallow here; the failure is surfaced on submit, where it is
          // actionable, rather than as an unhandled rejection now.
          coordsRef.current.catch(() => undefined);
        }
        setPhase('ready');
      } catch {
        if (!cancelled) setPhase('invalid');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const submit = useCallback(
    async (image?: string) => {
      setRetryable(false);
      setMessage('');
      setPhase('submitting');

      let coords: { latitude: number; longitude: number; accuracy?: number } | undefined;
      if (requires.location) {
        try {
          coords = await (coordsRef.current ?? getCurrentCoords());
        } catch (e: any) {
          // The permission text from the shared helper is the actionable part:
          // the employee has to change a browser setting, not retry blindly.
          setMessage(e?.message ?? 'Could not determine your location.');
          setRetryable(true);
          setPhase('error');
          // Ask again on the next attempt rather than replaying the rejection.
          coordsRef.current = null;
          return;
        }
      }

      try {
        const res = await fetch(`${API_BASE}/channel/verify/${token}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...FETCH_HEADERS },
          body: JSON.stringify({ ...(coords ?? {}), ...(image ? { image } : {}) }),
        });
        const body = await res.json();

        if (body?.data?.ok) {
          // The server's own label, already formatted in the EMPLOYEE's
          // timezone. The page used to choose between checkIn and checkOut
          // itself — and since the day's first check-in is always set, every
          // check-out was confirmed with the morning's time. Formatting here
          // would also use the BROWSER's zone and disagree with the chat.
          setDoneAt(body.data.atLabel || null);
          setPhase('done');
          return;
        }

        setMessage(body?.data?.message ?? 'That was not accepted.');
        setRetryable(Boolean(body?.data?.retryable));
        setPhase('error');
      } catch {
        setMessage('Could not reach the server. Check your connection and try again.');
        setRetryable(true);
        setPhase('error');
      }
    },
    [token, requires.location],
  );

  // Already formatted server-side; the page must not re-derive it.
  const time = doneAt;

  return (
    // `data-clarity-mask` — this page shows a live camera preview of whoever is
    // punching in and the capture taken from it. Nothing on it belongs in a
    // session recording, so the whole page is masked rather than parts of it.
    <main data-clarity-mask="true" className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
            {requires.face ? <ShieldCheck className="h-5 w-5" /> : <MapPin className="h-5 w-5" />}
          </div>
          <div>
            <h1 className="text-lg font-semibold text-slate-800">{label}</h1>
            <p className="text-sm text-slate-500">Started from a chat</p>
          </div>
        </div>

        {phase === 'checking' && (
          <p className="flex items-center gap-2 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking your link…
          </p>
        )}

        {phase === 'invalid' && (
          <div className="space-y-2">
            <p className="flex items-start gap-2 text-sm text-rose-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {INVALID_TEXT[invalidReason] ?? INVALID_TEXT.unknown}
            </p>
            <p className="text-sm text-slate-500">
              {invalidReason === 'used'
                ? 'Nothing more to do here.'
                : invalidReason === 'replaced'
                  ? 'Open the most recent message in the chat instead.'
                  : 'Ask for a new one from the chat.'}
            </p>
          </div>
        )}

        {insecure && phase !== 'invalid' && phase !== 'done' && (
          <p className="mb-4 flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            This page needs a secure (https) address to use the camera. Ask your administrator to
            set the portal URL.
          </p>
        )}

        {(phase === 'ready' || phase === 'submitting' || (phase === 'error' && retryable)) && (
          <div className="space-y-4">
            {phase === 'error' && retryable && (
              <p className="flex items-start gap-2 text-sm text-rose-700">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                {message}
              </p>
            )}

            <p className="text-sm text-slate-600">
              {requires.face && requires.location
                ? 'Take a photo to confirm it is you. Your location is captured at the same time — allow both when your browser asks.'
                : requires.face
                  ? 'Take a photo to confirm it is you.'
                  : 'Your branch records where you are. Allow location access when your browser asks.'}
            </p>

            {requires.face && !insecure ? (
              <WebcamCapture
                onCapture={(image) => void submit(image)}
                isProcessing={phase === 'submitting'}
                width={360}
                height={270}
                showPreview={false}
                buttonText={label}
              />
            ) : (
              <button
                type="button"
                onClick={() => void submit()}
                disabled={phase === 'submitting' || insecure}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
              >
                {phase === 'submitting' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <MapPin className="h-4 w-4" />
                )}
                {phase === 'submitting' ? 'Working…' : label}
              </button>
            )}

            <p className="text-center text-xs text-slate-400">
              This link works once and expires shortly.
            </p>
          </div>
        )}

        {phase === 'done' && (
          <div className="space-y-2">
            <p className="flex items-center gap-2 text-sm font-medium text-emerald-700">
              <CheckCircle2 className="h-5 w-5" /> {label} recorded{time ? ` at ${time}` : ''}
            </p>
            <p className="text-sm text-slate-500">You can close this page and go back to the chat.</p>
          </div>
        )}

        {phase === 'error' && !retryable && (
          <div className="space-y-2">
            <p className="flex items-start gap-2 text-sm text-rose-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {message}
            </p>
            <p className="text-sm text-slate-500">Ask for a new link from the chat.</p>
          </div>
        )}
      </div>
    </main>
  );
}

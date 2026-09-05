'use client';

import { useCallback, useRef, useState } from 'react';
import { Terminal } from 'lucide-react';
import { useDevMode, useDevModeCountdown } from '@/hooks/useDevMode';
import DevModeDialog from './DevModeDialog';

/** Taps needed to open the prompt. */
const TAPS_REQUIRED = 5;
/** A gap longer than this restarts the count, so stray clicks never accumulate. */
const TAP_WINDOW_MS = 1500;

/**
 * The unobtrusive entry point to developer mode, in the header action cluster.
 *
 * Locked, it is a dim dot that gives no feedback until the fifth tap — the point
 * is that a curious admin clicking it once learns nothing. Unlocked, it becomes
 * a labelled chip with the remaining time, because an active elevation should be
 * impossible to forget about.
 *
 * Renders nothing at all when the backend reports no developer password
 * configured, so deployments that do not use the feature show no trace of it.
 */
export default function DevModeToggle() {
  const { available, unlocked, exit } = useDevMode();
  const countdown = useDevModeCountdown();

  const [dialogOpen, setDialogOpen] = useState(false);
  const taps = useRef(0);
  const lastTap = useRef(0);

  const handleTap = useCallback(() => {
    if (unlocked) {
      void exit();
      taps.current = 0;
      return;
    }

    const now = Date.now();
    taps.current = now - lastTap.current > TAP_WINDOW_MS ? 1 : taps.current + 1;
    lastTap.current = now;

    if (taps.current >= TAPS_REQUIRED) {
      taps.current = 0;
      setDialogOpen(true);
    }
  }, [unlocked, exit]);

  if (!available) return null;

  return (
    <>
      <button
        onClick={handleTap}
        // No aria-label naming developer mode while locked — a screen reader
        // should not announce the hidden surface either.
        aria-label={unlocked ? 'Exit developer mode' : 'Build info'}
        title={unlocked ? `Developer mode — ${countdown ?? 'expiring'} left. Click to exit.` : ''}
        className={
          unlocked
            ? 'flex items-center gap-1.5 rounded-lg bg-brand-primary/10 px-2 py-1.5 text-xs font-semibold text-brand-primary transition-colors hover:bg-brand-primary/20'
            : 'rounded-lg p-2 text-text-muted/30 transition-colors hover:text-text-muted/60'
        }
      >
        <Terminal size={unlocked ? 14 : 16} />
        {unlocked && <span className="tabular-nums">DEV {countdown ?? ''}</span>}
      </button>

      <DevModeDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </>
  );
}

'use client';

import Link from 'next/link';
import { AlertTriangle, ArrowRight } from 'lucide-react';

/**
 * Shown when a dropdown's master list is empty.
 *
 * A select whose options come from a master renders as a bare placeholder when
 * that master has no rows — the form looks broken and gives no clue that the fix
 * is one screen away. This says what is missing and links straight to it.
 */
export default function MasterEmptyHint({
  what,
  href = '/dashboard/settings?tab=libraries',
  linkLabel = 'Settings → Library',
  className = '',
}: {
  /** Plural noun for the missing rows, e.g. "travel destinations". */
  what: string;
  href?: string;
  linkLabel?: string;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 ${className}`}
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      <span>
        No {what} configured yet, so that dropdown is empty.
      </span>
      <Link
        href={href}
        className="inline-flex items-center gap-1 font-semibold text-amber-900 underline underline-offset-2"
      >
        {linkLabel} <ArrowRight size={11} />
      </Link>
    </div>
  );
}

'use client';

import { useState } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { useTranslations } from 'next-intl';
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';

export type AttentionSeverity = 'critical' | 'warning' | 'info';

export interface AttentionItem {
  key: string;
  /** Who or what needs attention — a name, a record, a department. */
  label: string;
  /** Why, in three or four words: "12 days left", "overdue since July". */
  detail?: string;
  severity?: AttentionSeverity;
  href?: string;
}

const SEVERITY: Record<AttentionSeverity, string> = {
  critical: 'border-status-error/30 bg-status-error-bg text-status-error',
  warning: 'border-status-warning/30 bg-status-warning-bg text-status-warning',
  info: 'border-status-info/30 bg-status-info-bg text-status-info',
};

/** The left edge is the severity, readable before the words are. */
const ACCENT: Record<AttentionSeverity, string> = {
  critical: 'bg-status-error',
  warning: 'bg-status-warning',
  info: 'bg-status-info',
};

interface AttentionStripProps {
  /** Already translated by the caller. */
  title: string;
  items: AttentionItem[];
  /** "See all 23" — the escape hatch when the strip is a sample, not the set. */
  seeAll?: { label: string; href: string };
  loading?: boolean;
  emptyLabel?: string;
}

/**
 * The list of things that will go wrong if nobody looks.
 *
 * Closed by default and opened on a click, stacked rather than scrolled
 * sideways — a horizontal strip hides its own overflow, and the worst item can
 * sit off-screen with nothing on the page saying so. The header carries the
 * count whether the list is open or shut.
 */
export default function AttentionStrip({
  title,
  items,
  seeAll,
  loading = false,
  emptyLabel,
}: AttentionStripProps) {
  // Every other string arrives pre-translated from the caller; the toggle is
  // this component's own affordance, so it owns its own words.
  const tm = useTranslations('moduleLanding');
  const [expanded, setExpanded] = useState(false);

  if (loading) {
    return (
      <div className="surface-panel rounded-[20px] p-4">
        <div className="h-3.5 w-32 animate-pulse rounded bg-surface-border" />
      </div>
    );
  }

  const hasItems = items.length > 0;

  return (
    <div className="surface-panel rounded-[20px] p-4">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          disabled={!hasItems}
          aria-expanded={hasItems ? expanded : undefined}
          aria-label={hasItems ? (expanded ? tm('attnCollapse') : tm('attnExpand')) : undefined}
          className="flex min-w-0 items-center gap-2 text-[14px] font-bold text-text-heading disabled:cursor-default"
        >
          <AlertTriangle
            size={15}
            className={hasItems ? 'text-status-warning' : 'text-text-muted'}
            aria-hidden
          />
          <span className="truncate">{title}</span>
          {hasItems && (
            <>
              <span className="rounded-full bg-surface-border px-2 py-0.5 text-[11px] font-bold text-text-muted">
                {items.length}
              </span>
              <ChevronDown
                size={15}
                aria-hidden
                className={`text-text-muted transition-transform ${expanded ? 'rotate-180' : ''}`}
              />
            </>
          )}
        </button>
        {seeAll && hasItems && (
          <Link
            href={seeAll.href}
            className="shrink-0 text-[12px] font-semibold text-brand-primary hover:underline"
          >
            {seeAll.label}
          </Link>
        )}
      </div>

      {!hasItems ? (
        <p className="mt-3 text-xs font-medium text-text-muted">{emptyLabel}</p>
      ) : (
        // Hidden while collapsed, never unmounted: the count in the header and
        // what the DOM holds must not be able to disagree.
        <div
          className={
            expanded ? 'mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3' : 'hidden'
          }
        >
          {items.map((item, i) => {
            const severity = item.severity ?? 'warning';
            const inner = (
              <>
                <span className={`w-1 shrink-0 self-stretch rounded-full ${ACCENT[severity]}`} />
                <span className="min-w-0 flex-1 truncate text-xs font-bold">{item.label}</span>
                {item.detail && (
                  <span className="max-w-[45%] shrink-0 truncate text-[11px] font-semibold opacity-85 text-end">
                    {item.detail}
                  </span>
                )}
                {item.href && (
                  <ChevronRight size={14} aria-hidden className="shrink-0 opacity-60 rtl:rotate-180" />
                )}
              </>
            );
            // The grid cell sets the width; the row fills it and truncates a
            // long label rather than stretching across the panel.
            const shell = `flex h-full w-full items-center gap-2.5 rounded-xl border py-2.5 ps-2 pe-3 shadow-2xs ${SEVERITY[severity]}`;

            return (
              <motion.div
                key={item.key}
                className="h-full min-w-0"
                initial={{ opacity: 0, y: -1 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: 0.05 * Math.min(i, 6) }}
              >
                {item.href ? (
                  <Link href={item.href} className={`${shell} transition-all hover:brightness-95`}>
                    {inner}
                  </Link>
                ) : (
                  <span className={shell}>{inner}</span>
                )}
              </motion.div>
            );
          })}
        </div>
      )}
    </div>
  );
}

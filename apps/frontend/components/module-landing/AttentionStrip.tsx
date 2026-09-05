'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { motion } from 'framer-motion';
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';

export type AttentionSeverity = 'critical' | 'warning' | 'info';

export interface AttentionItem {
  key: string;
  /** Who or what needs attention — a name, a record, a department. */
  label: string;
  /** Why, in three or four words: "12 days left", "overdue since Jul". */
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
 * sideways: a horizontal strip hid its own overflow — the worst item could sit
 * off-screen with nothing on the page saying so. The header carries the count
 * whether the list is open or shut, and the rows stay mounted while closed, so
 * nothing here is ever unreachable or silently uncounted.
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
      <div className="surface-panel p-4 rounded-[20px]">
        <div className="h-3.5 w-32 rounded bg-surface-border animate-pulse" />
      </div>
    );
  }

  const hasItems = items.length > 0;

  return (
    <div className="surface-panel p-4 rounded-[20px]">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          disabled={!hasItems}
          aria-expanded={hasItems ? expanded : undefined}
          aria-label={hasItems ? (expanded ? tm('attnCollapse') : tm('attnExpand')) : undefined}
          className="flex min-w-0 items-center gap-2 text-[14px] font-bold text-text-heading disabled:cursor-default"
        >
          <AlertTriangle size={15} className={hasItems ? 'text-status-warning' : 'text-text-muted'} />
          <span className="truncate">{title}</span>
          {hasItems && (
            <>
              <span className="rounded-full bg-surface-border px-2 py-0.5 text-[11px] font-bold text-text-muted">
                {items.length}
              </span>
              <ChevronDown
                size={15}
                className={`text-text-muted transition-transform ${expanded ? 'rotate-180' : ''}`}
              />
            </>
          )}
        </button>
        {seeAll && hasItems && (
          <Link
            href={seeAll.href}
            className="text-[12px] font-semibold text-brand-primary hover:underline shrink-0"
          >
            {seeAll.label}
          </Link>
        )}
      </div>

      {!hasItems ? (
        <p className="mt-3 text-xs text-text-muted font-medium">{emptyLabel}</p>
      ) : (
        // Kept mounted while closed rather than unmounted, so the count in the
        // header and what the DOM holds can never disagree.
        <div
          className={
            expanded
              ? 'mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3'
              : 'hidden'
          }
        >
          {items.map((item, i) => {
            const severity = item.severity ?? 'warning';
            const tone = SEVERITY[severity];
            const inner = (
              <>
                <span className={`w-1 self-stretch shrink-0 rounded-full ${ACCENT[severity]}`} />
                <span className="text-xs font-bold truncate flex-1 min-w-0">{item.label}</span>
                {item.detail && (
                  <span className="text-[11px] font-semibold opacity-85 text-end shrink-0 max-w-[45%] truncate">
                    {item.detail}
                  </span>
                )}
                {item.href && <ChevronRight size={14} className="opacity-60 shrink-0 rtl:rotate-180" />}
              </>
            );
            // The grid cell sets the width; the card fills it and truncates a
            // long label rather than stretching the row across the panel.
            const shell =
              'h-full w-full flex items-center gap-2.5 ps-2 pe-3 py-2.5 ' +
              `rounded-xl border shadow-2xs ${tone}`;

            return (
              <motion.div
                key={item.key}
                className="min-w-0 h-full"
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.18, delay: 0.02 * Math.min(i, 6) }}
              >
                {item.href ? (
                  <Link href={item.href} className={`${shell} hover:brightness-95 hover:shadow-xs transition-all`}>
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

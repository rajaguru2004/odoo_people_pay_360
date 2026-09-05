'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { PaginationMeta } from '@/types/api';

/**
 * The footer of a paginated list: where the reader is, and the two ways out.
 *
 * Driven by the `meta` block the API already returns rather than by a count the
 * page worked out from `rows.length` — a page of twenty rows out of two hundred
 * would otherwise announce itself as the whole set.
 *
 * Renders nothing for a single page. A pager under a list that fits on screen is
 * furniture, and the "1" it draws is not a choice anybody can make.
 */
export function Pagination({
  meta,
  onPageChange,
}: {
  meta?: PaginationMeta;
  onPageChange: (page: number) => void;
}) {
  if (!meta || meta.totalPages <= 1) return null;

  const { page, limit, total, totalPages } = meta;
  const first = (page - 1) * limit + 1;
  const last = Math.min(page * limit, total);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-surface-border-light px-5 py-3">
      <p className="text-sm text-text-muted">
        Showing <span className="font-medium tabular-nums text-text-body">{first}</span>–
        <span className="font-medium tabular-nums text-text-body">{last}</span> of{' '}
        <span className="font-medium tabular-nums text-text-body">{total}</span>
      </p>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          aria-label="Previous page"
          className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-button)] border border-surface-border text-text-body transition-colors hover:bg-surface-border-light disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ChevronLeft className="h-4 w-4 rtl:rotate-180" aria-hidden />
        </button>
        <span className="text-sm tabular-nums text-text-muted">
          Page {page} of {totalPages}
        </span>
        <button
          type="button"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
          aria-label="Next page"
          className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-button)] border border-surface-border text-text-body transition-colors hover:bg-surface-border-light disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ChevronRight className="h-4 w-4 rtl:rotate-180" aria-hidden />
        </button>
      </div>
    </div>
  );
}

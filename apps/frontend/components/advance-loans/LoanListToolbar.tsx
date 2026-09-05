'use client';

import React, { useEffect, useState } from 'react';
import { Search, X } from 'lucide-react';
import { LOAN_STATUS_FILTERS } from './loanStatus';

export interface LoanListFilters {
  /** Free text — matched server-side against name, code and reference. */
  search: string;
  /** Key from LOAN_STATUS_FILTERS. */
  statusKey: string;
  /** '' | 'ADVANCE' | 'LOAN' */
  type: string;
}

interface Props {
  value: LoanListFilters;
  onChange: (next: LoanListFilters) => void;
  /** Rows currently shown, and the server-side total behind the filters. */
  shown: number;
  total: number;
  loading: boolean;
}

/**
 * Search + filters for the request list.
 *
 * The search box is debounced and its text is held LOCALLY, committed to the
 * parent 350ms after typing stops. Lifting every keystroke straight into the
 * parent would refetch per character and — because the parent owns the input's
 * value — let a slow response overwrite what the user had already typed next.
 *
 * Filters are status GROUPS, not one chip per enum value. "Active" covering
 * APPROVED/DISBURSED/ACTIVE is the question people ask; thirteen chips is the
 * schema, not a filter.
 */
export default function LoanListToolbar({
  value,
  onChange,
  shown,
  total,
  loading,
}: Props) {
  const [text, setText] = useState(value.search);

  // Keep the box in step when the parent resets filters (e.g. on tab change).
  useEffect(() => {
    setText(value.search);
  }, [value.search]);

  useEffect(() => {
    if (text === value.search) return;
    const t = setTimeout(() => onChange({ ...value, search: text }), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const chip = (active: boolean) =>
    `h-8 rounded-full px-3 text-xs font-medium transition-colors ${
      active
        ? 'bg-brand-primary text-text-on-brand'
        : 'border border-surface-border text-text-muted hover:bg-surface-page hover:text-text-body'
    }`;

  const hasFilters =
    !!value.search || value.statusKey !== 'all' || !!value.type;

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1 min-w-0">
          <Search
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <input
            data-testid="loan-search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search name, employee code or reference…"
            aria-label="Search requests"
            className="h-10 w-full rounded-lg border border-surface-border bg-surface-card pl-9 pr-9 text-sm outline-none focus:border-brand-primary"
          />
          {text && (
            <button
              onClick={() => setText('')}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-text-muted hover:bg-surface-page"
            >
              <X size={14} />
            </button>
          )}
        </div>

        <select
          data-testid="loan-filter-type"
          value={value.type}
          onChange={(e) => onChange({ ...value, type: e.target.value })}
          aria-label="Filter by type"
          className="h-10 rounded-lg border border-surface-border bg-surface-card px-3 text-sm outline-none focus:border-brand-primary"
        >
          <option value="">All types</option>
          <option value="ADVANCE">Salary advances</option>
          <option value="LOAN">Loans</option>
        </select>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {LOAN_STATUS_FILTERS.map((f) => (
          <button
            key={f.key}
            data-testid={`loan-filter-status-${f.key}`}
            data-key={f.key}
            data-value={f.value}
            data-active={value.statusKey === f.key}
            onClick={() => onChange({ ...value, statusKey: f.key })}
            className={chip(value.statusKey === f.key)}
          >
            {f.label}
          </button>
        ))}

        {/* The counts are carried as attributes as well as words: the sentence
            is English prose with four shapes, and a reader — human or test —
            asking "how many matched?" should not have to parse it. */}
        <span
          data-testid="loan-result-count"
          data-shown={shown}
          data-total={total}
          data-loading={loading}
          className="ms-auto text-xs text-text-muted"
          aria-live="polite"
        >
          {loading
            ? 'Loading…'
            : total === 0
              ? 'No matches'
              : shown === total
                ? `${total} request${total === 1 ? '' : 's'}`
                : `Showing ${shown} of ${total}`}
        </span>

        {hasFilters && !loading && (
          <button
            data-testid="loan-clear-filters"
            onClick={() => onChange({ search: '', statusKey: 'all', type: '' })}
            className="text-xs font-medium text-brand-primary hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>
    </div>
  );
}

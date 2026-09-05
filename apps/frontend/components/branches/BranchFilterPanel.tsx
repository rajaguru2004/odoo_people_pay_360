'use client';

import { useState, type ReactNode } from 'react';
import { Download, Search, SlidersHorizontal, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Select } from '@/components/ui/Select';
import {
  activeBranchFilterCount,
  EMPTY_BRANCH_FILTERS,
  type BranchFilters,
} from './branchFacts';

/**
 * Search, the filters folded behind it, and the way out to a spreadsheet.
 *
 * The status choice is the only control over retired branches. A separate
 * "include retired" toggle beside a status select gives the reader two
 * contradictory switches for one question — and the API filters retired rows
 * out server-side, so the pair would also disagree about what "All" means.
 */
export default function BranchFilterPanel({
  filters,
  onChange,
  countries,
  shown,
  total,
  onExport,
  exporting,
  trailing,
}: {
  filters: BranchFilters;
  onChange: (filters: BranchFilters) => void;
  countries: string[];
  shown: number;
  total: number;
  onExport: () => void;
  exporting: boolean;
  /** The view switcher, so search and view sit on one toolbar. */
  trailing?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const count = activeBranchFilterCount(filters);
  const set = (patch: Partial<BranchFilters>) => onChange({ ...filters, ...patch });

  return (
    <Card className="space-y-4 p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="relative w-full lg:max-w-md">
          <label htmlFor="branch-search" className="sr-only">
            Search branches
          </label>
          <Search
            className="pointer-events-none absolute inset-y-0 start-3 my-auto h-4 w-4 text-text-muted"
            aria-hidden
          />
          <input
            id="branch-search"
            data-testid="branch-search"
            type="search"
            value={filters.search}
            onChange={(event) => set({ search: event.target.value })}
            placeholder="Name, code, city or country"
            className="w-full rounded-[var(--radius-input)] border border-surface-border bg-surface-card py-2 pe-3 ps-9 text-sm text-text-body placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-brand-primary/40"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={open || count > 0 ? 'primary' : 'outline'}
            size="sm"
            aria-expanded={open}
            aria-controls="branch-filters"
            onClick={() => setOpen((value) => !value)}
          >
            <SlidersHorizontal className="h-4 w-4" aria-hidden />
            Filters
            {count > 0 && (
              <span className="rounded-[var(--radius-badge)] bg-surface-card px-1.5 text-xs font-semibold tabular-nums text-brand-primary">
                {count}
              </span>
            )}
          </Button>
          <Button variant="outline" size="sm" onClick={onExport} isLoading={exporting}>
            <Download className="h-4 w-4" aria-hidden />
            Export
          </Button>
          {trailing}
        </div>
      </div>

      {open && (
        <div id="branch-filters" className="grid gap-3 border-t border-surface-border-light pt-4 sm:grid-cols-2 lg:grid-cols-4">
          <Select
            label="Status"
            value={filters.status}
            onChange={(event) => set({ status: event.target.value as BranchFilters['status'] })}
          >
            <option value="all">Open and retired</option>
            <option value="active">Open only</option>
            <option value="retired">Retired only</option>
          </Select>

          <Select
            label="Country"
            placeholder="Everywhere"
            value={filters.country}
            onChange={(event) => set({ country: event.target.value })}
          >
            {countries.map((country) => (
              <option key={country} value={country}>
                {country}
              </option>
            ))}
          </Select>

          <Select
            label="Geofence"
            value={filters.fence}
            onChange={(event) => set({ fence: event.target.value as BranchFilters['fence'] })}
          >
            <option value="all">Fenced or not</option>
            <option value="fenced">Fence applies</option>
            <option value="unfenced">No working fence</option>
          </Select>

          {count > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="self-end justify-start"
              onClick={() => onChange({ ...EMPTY_BRANCH_FILTERS, search: filters.search })}
            >
              <X className="h-4 w-4" aria-hidden />
              Clear {count} filter{count === 1 ? '' : 's'}
            </Button>
          )}
        </div>
      )}

      <p className="border-t border-surface-border-light pt-3 text-sm text-text-muted">
        Showing <span className="font-medium tabular-nums text-text-body">{shown}</span> of{' '}
        <span className="font-medium tabular-nums text-text-body">{total}</span>{' '}
        {total === 1 ? 'branch' : 'branches'}
      </p>
    </Card>
  );
}

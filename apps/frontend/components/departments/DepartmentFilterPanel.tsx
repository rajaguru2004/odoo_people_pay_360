'use client';

import { useState, type ReactNode } from 'react';
import { Download, Search, SlidersHorizontal, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Select } from '@/components/ui/Select';
import {
  activeDepartmentFilterCount,
  EMPTY_DEPARTMENT_FILTERS,
  type DepartmentFilters,
} from './departmentFacts';
import type { Branch } from '@/types/branch';

export default function DepartmentFilterPanel({
  filters,
  onChange,
  branches,
  shown,
  total,
  onExport,
  exporting,
  trailing,
}: {
  filters: DepartmentFilters;
  onChange: (filters: DepartmentFilters) => void;
  branches: Branch[];
  shown: number;
  total: number;
  onExport: () => void;
  exporting: boolean;
  /** The view switcher, so search and view sit on one toolbar. */
  trailing?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const count = activeDepartmentFilterCount(filters);
  const set = (patch: Partial<DepartmentFilters>) => onChange({ ...filters, ...patch });

  return (
    <Card className="space-y-4 p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="relative w-full lg:max-w-md">
          <label htmlFor="department-search" className="sr-only">
            Search departments
          </label>
          <Search
            className="pointer-events-none absolute inset-y-0 start-3 my-auto h-4 w-4 text-text-muted"
            aria-hidden
          />
          <input
            id="department-search"
            data-testid="department-search"
            type="search"
            value={filters.search}
            onChange={(event) => set({ search: event.target.value })}
            placeholder="Name, code or branch"
            className="w-full rounded-[var(--radius-input)] border border-surface-border bg-surface-card py-2 pe-3 ps-9 text-sm text-text-body placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-brand-primary/40"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={open || count > 0 ? 'primary' : 'outline'}
            size="sm"
            aria-expanded={open}
            aria-controls="department-filters"
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
        <div
          id="department-filters"
          className="grid gap-3 border-t border-surface-border-light pt-4 sm:grid-cols-2 lg:grid-cols-4"
        >
          <Select
            label="Status"
            value={filters.status}
            onChange={(event) =>
              set({ status: event.target.value as DepartmentFilters['status'] })
            }
          >
            <option value="open">Open only</option>
            <option value="closed">Closed only</option>
            <option value="all">Open and closed</option>
          </Select>

          <Select
            label="Branch"
            placeholder="Every location"
            value={filters.branchId}
            onChange={(event) => set({ branchId: event.target.value })}
          >
            {branches.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name}
              </option>
            ))}
          </Select>

          <Select
            label="Head"
            value={filters.head}
            onChange={(event) => set({ head: event.target.value as DepartmentFilters['head'] })}
          >
            <option value="all">With or without</option>
            <option value="headed">Has a head</option>
            <option value="headless">Nobody in charge</option>
          </Select>

          <Select
            label="Level"
            value={filters.level}
            onChange={(event) => set({ level: event.target.value as DepartmentFilters['level'] })}
          >
            <option value="all">Any level</option>
            <option value="top">Top level</option>
            <option value="sub">Reports upward</option>
          </Select>

          {count > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="justify-start"
              onClick={() => onChange({ ...EMPTY_DEPARTMENT_FILTERS, search: filters.search })}
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
        {total === 1 ? 'unit' : 'units'}
      </p>
    </Card>
  );
}

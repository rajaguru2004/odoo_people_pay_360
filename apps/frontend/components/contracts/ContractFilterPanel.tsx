'use client';

import { useState, type ReactNode } from 'react';
import { Download, Search, SlidersHorizontal, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import {
  activeContractFilterCount,
  CONTRACT_STATUS_OPTIONS,
  CONTRACT_TYPE_OPTIONS,
  EMPTY_CONTRACT_FILTERS,
  humanise,
  WORK_TYPE_OPTIONS,
  type ContractFilters,
} from './contractFacts';

/**
 * Search, the filters folded behind it, and the way out to a spreadsheet.
 *
 * Each select carries a visible label rather than an `aria-label`, now that
 * they sit in a panel with room for one. A control whose only name is invisible
 * cannot be pointed at across a desk.
 */
export default function ContractFilterPanel({
  filters,
  onChange,
  shown,
  total,
  onExport,
  exporting,
  trailing,
}: {
  filters: ContractFilters;
  onChange: (filters: ContractFilters) => void;
  shown: number;
  total?: number;
  onExport: () => void;
  exporting: boolean;
  /** The view switcher, so search and view sit on one toolbar. */
  trailing?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const count = activeContractFilterCount(filters);
  const set = (patch: Partial<ContractFilters>) => onChange({ ...filters, ...patch });

  return (
    <Card className="space-y-4 p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="w-full lg:max-w-md">
          <Input
            value={filters.search}
            onChange={(event) => set({ search: event.target.value })}
            aria-label="Search contracts"
            placeholder="Contract number, employee code or name"
            icon={<Search className="h-4 w-4" aria-hidden />}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={open || count > 0 ? 'primary' : 'outline'}
            size="sm"
            aria-expanded={open}
            aria-controls="contract-filters"
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
          id="contract-filters"
          className="grid gap-3 border-t border-surface-border-light pt-4 sm:grid-cols-2 lg:grid-cols-4"
        >
          <Select
            label="Status"
            placeholder="Every status"
            value={filters.status}
            onChange={(event) =>
              set({ status: event.target.value as ContractFilters['status'] })
            }
          >
            {CONTRACT_STATUS_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {humanise(option)}
              </option>
            ))}
          </Select>

          <Select
            label="Contract type"
            placeholder="Every type"
            value={filters.contractType}
            onChange={(event) =>
              set({ contractType: event.target.value as ContractFilters['contractType'] })
            }
          >
            {CONTRACT_TYPE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {humanise(option)}
              </option>
            ))}
          </Select>

          <Select
            label="Work type"
            placeholder="Every arrangement"
            value={filters.workType}
            onChange={(event) =>
              set({ workType: event.target.value as ContractFilters['workType'] })
            }
          >
            {WORK_TYPE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {humanise(option)}
              </option>
            ))}
          </Select>

          <Select
            label="Ending within"
            placeholder="Any time"
            value={filters.expiringWithinDays}
            onChange={(event) => set({ expiringWithinDays: event.target.value })}
          >
            <option value="30">30 days</option>
            <option value="60">60 days</option>
            <option value="90">90 days</option>
          </Select>

          {count > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="justify-start"
              onClick={() => onChange({ ...EMPTY_CONTRACT_FILTERS, search: filters.search })}
            >
              <X className="h-4 w-4" aria-hidden />
              Clear {count} filter{count === 1 ? '' : 's'}
            </Button>
          )}
        </div>
      )}

      <p className="border-t border-surface-border-light pt-3 text-sm text-text-muted">
        Showing <span className="font-medium tabular-nums text-text-body">{shown}</span> of{' '}
        {/* An em dash while the count is unknown: "of 0" would read as an empty
            file rather than an answer that has not arrived. */}
        <span className="font-medium tabular-nums text-text-body">{total ?? '—'}</span>{' '}
        {total === 1 ? 'contract' : 'contracts'}
      </p>
    </Card>
  );
}

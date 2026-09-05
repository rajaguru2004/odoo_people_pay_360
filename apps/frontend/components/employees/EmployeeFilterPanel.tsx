'use client';

import { useState, type ReactNode } from 'react';
import { Download, Search, SlidersHorizontal, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import {
  activeEmployeeFilterCount,
  EMPLOYEE_STATUS_OPTIONS,
  EMPTY_EMPLOYEE_FILTERS,
  type EmployeeFilters,
} from './employeeFacts';
import type { NamedRef } from '@/types/common';
import type { EmployeeStatus } from '@/types/employee';

/**
 * Search, the three ways of narrowing it, and the way out to a spreadsheet.
 *
 * The panel starts OPEN. Every other list in the module folds its filters away
 * behind the button, but the directory has shown these three selects on the
 * toolbar since it was built, and collapsing them on an existing screen takes a
 * control away from people who already reach for it. The button is still here
 * for anyone who wants the room back.
 */
export default function EmployeeFilterPanel({
  filters,
  onChange,
  departments,
  branches,
  onExport,
  exporting,
  trailing,
}: {
  filters: EmployeeFilters;
  onChange: (filters: EmployeeFilters) => void;
  departments: NamedRef[];
  branches: NamedRef[];
  onExport: () => void;
  exporting: boolean;
  /** The view switcher, so search and view sit on one toolbar. */
  trailing?: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const count = activeEmployeeFilterCount(filters);
  const set = (patch: Partial<EmployeeFilters>) =>
    onChange({ ...filters, ...patch });

  return (
    <Card className="space-y-4 p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="w-full lg:max-w-md">
          <Input
            value={filters.search}
            onChange={(event) => set({ search: event.target.value })}
            aria-label="Search employees"
            placeholder="Name, code or work email"
            icon={<Search className="h-4 w-4" aria-hidden />}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={open || count > 0 ? 'primary' : 'outline'}
            size="sm"
            aria-expanded={open}
            aria-controls="employee-filters"
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
          <Button
            variant="outline"
            size="sm"
            onClick={onExport}
            isLoading={exporting}
          >
            <Download className="h-4 w-4" aria-hidden />
            Export
          </Button>
          {trailing}
        </div>
      </div>

      {open && (
        <div
          id="employee-filters"
          className="grid gap-3 border-t border-surface-border-light pt-4 sm:grid-cols-2 lg:grid-cols-4"
        >
          <Select
            label="Department"
            placeholder="Every department"
            value={filters.departmentId}
            onChange={(event) => set({ departmentId: event.target.value })}
          >
            {departments.map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
          </Select>

          <Select
            label="Branch"
            placeholder="Every branch"
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
            label="Status"
            placeholder="Every status"
            value={filters.status}
            onChange={(event) =>
              set({ status: event.target.value as '' | EmployeeStatus })
            }
          >
            {EMPLOYEE_STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>

          {count > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="justify-start self-end"
              // The search box keeps what is in it: it is visible on the
              // toolbar with its own text, so wiping it from a control labelled
              // for the three selects would clear something the reader was not
              // pointing at.
              onClick={() =>
                onChange({ ...EMPTY_EMPLOYEE_FILTERS, search: filters.search })
              }
            >
              <X className="h-4 w-4" aria-hidden />
              Clear {count} filter{count === 1 ? '' : 's'}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

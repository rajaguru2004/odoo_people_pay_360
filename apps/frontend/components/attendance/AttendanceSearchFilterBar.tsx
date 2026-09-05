'use client';

import type { ReactNode } from 'react';
import { Search, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';

/** One dropdown on the bar. `''` is always "no narrowing", never a real value. */
export interface AttendanceFilterSelect {
  key: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** The first row, shown when nothing is chosen — "Every department". */
  placeholder: string;
  options: Array<{ value: string; label: string }>;
}

/**
 * The filter row an attendance list is read through.
 *
 * The selects are data rather than props with names, so one bar serves screens
 * that narrow by different things without growing an argument per screen. What
 * stays fixed is the shape: search first, dropdowns after, and a Clear that
 * only appears once there is something to clear — a permanently visible reset
 * on an untouched screen is a control with nothing to do.
 *
 * `leading` and `trailing` are for controls that belong to the bar but are not
 * filters: a month stepper on one end, an export button on the other.
 */
export function AttendanceSearchFilterBar({
  search,
  onSearchChange,
  searchLabel = 'Employee',
  searchPlaceholder = 'Name, code or department',
  filters = [],
  onClear,
  leading,
  trailing,
}: {
  search: string;
  onSearchChange: (value: string) => void;
  searchLabel?: string;
  searchPlaceholder?: string;
  filters?: AttendanceFilterSelect[];
  onClear: () => void;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  const narrowed = Boolean(search.trim()) || filters.some((f) => f.value);

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-end gap-3">
        {leading}

        <div className="w-full sm:w-64">
          <Input
            label={searchLabel}
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={searchPlaceholder}
            icon={<Search className="h-4 w-4" aria-hidden />}
          />
        </div>

        {filters.map((filter) => (
          <div key={filter.key} className="w-full sm:w-48">
            <Select
              label={filter.label}
              placeholder={filter.placeholder}
              value={filter.value}
              onChange={(event) => filter.onChange(event.target.value)}
            >
              {filter.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
        ))}

        <div className="ms-auto flex items-end gap-2">
          {narrowed && (
            <Button variant="ghost" onClick={onClear}>
              <X className="h-4 w-4" aria-hidden />
              Clear
            </Button>
          )}
          {trailing}
        </div>
      </div>
    </Card>
  );
}

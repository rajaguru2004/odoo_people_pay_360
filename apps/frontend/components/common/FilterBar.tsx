'use client';

import type { ReactNode } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '@/utils/cn';
import { inputClass } from './Field';

/**
 * The row of filters above a list.
 *
 * Deliberately dumb — it is a container with one job: **one column below 768px,
 * the existing flex row at and above it**, with children stretched to the full
 * width rather than allowed to declare their own.
 *
 * That last part is the whole point. The pattern that breaks a phone in this
 * codebase is not a wide table, it is a `flex flex-wrap` filter row whose
 * children carry `min-w-[140px]`…`min-w-[220px]`: at 390px two of them wrap to
 * a second row and the third overflows the viewport. Six ESS screens do this.
 * Children of `FilterBar` get `w-full md:w-auto` from the container, so a fixed
 * minimum cannot be expressed by accident.
 *
 * Wrap it in `.ess-sticky-bar` when the list below is long — see `app/globals.css`
 * for why a sticky child of `<main>` has to full-bleed its gutter.
 */
export function FilterBar({
  children,
  className,
  testId,
}: {
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        'grid grid-cols-1 gap-2 md:flex md:flex-wrap md:items-center md:gap-3',
        '[&>*]:w-full md:[&>*]:w-auto',
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** Announced name. Defaults to the placeholder, which is better than nothing. */
  ariaLabel?: string;
  className?: string;
  testId?: string;
}

/**
 * The search box, of which there were twenty-seven hand-rolled copies.
 *
 * Three things the copies got wrong and this does not: `text-base`, so focusing
 * it does not zoom the page on iOS; logical `start-3`/`ps-10` rather than
 * `left-3`/`pl-9`, so the icon is on the correct side under `dir="rtl"`; and a
 * 44px clear button, because on a phone "get back to the full list" is the most
 * common thing a reader wants from a search box.
 */
export function SearchInput({
  value,
  onChange,
  placeholder,
  ariaLabel,
  className,
  testId,
}: SearchInputProps) {
  return (
    <div className={cn('relative', className)}>
      <Search
        size={18}
        aria-hidden="true"
        className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-text-muted"
      />
      <input
        type="search"
        enterKeyHint="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        data-testid={testId}
        className={cn(inputClass, 'ps-10', value ? 'pe-12' : 'pe-3')}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          data-testid={testId ? `${testId}-clear` : undefined}
          className="absolute end-1 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 touch-manipulation items-center justify-center rounded-lg text-text-muted transition-colors hover:text-text-body"
        >
          <X size={16} />
        </button>
      )}
    </div>
  );
}

'use client';

import type { ComponentType, SVGProps } from 'react';

export interface ViewOption<T extends string> {
  id: T;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}

/**
 * The Cards / Table toggle that sits above a list.
 *
 * A radio group rather than a row of toggle buttons: the views are mutually
 * exclusive, so `aria-pressed` on each would tell a screen reader there are
 * three independent switches and leave it to the listener to work out that
 * turning one on turns the others off. `role="radio"` states the exclusivity
 * once, and arrow keys move between the options for free.
 *
 * The label text collapses on a narrow screen, so the accessible name comes
 * from `aria-label` rather than from the visible span. An icon alone is not a
 * name, and a switcher nobody can name is a switcher nobody can reach by
 * voice.
 */
export function ViewSwitcher<T extends string>({
  options,
  value,
  onChange,
  label,
  testIdPrefix,
}: {
  options: ReadonlyArray<ViewOption<T>>;
  value: T;
  onChange: (view: T) => void;
  /** Names the group itself, e.g. "Branch view". */
  label: string;
  /** `${prefix}-cards`, `${prefix}-table` — what the browser specs select by. */
  testIdPrefix: string;
}) {
  const move = (delta: number) => {
    const index = options.findIndex((option) => option.id === value);
    const next = options[(index + delta + options.length) % options.length];
    if (next) onChange(next.id);
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          event.preventDefault();
          move(1);
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          event.preventDefault();
          move(-1);
        }
      }}
      className="inline-flex items-center gap-1 rounded-[var(--radius-input)] border border-surface-border bg-surface-page p-1"
    >
      {options.map((option) => {
        const Icon = option.icon;
        const active = option.id === value;

        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={active}
            // Only the selected option is in the tab order; the arrow keys are
            // how a keyboard moves within a radio group.
            tabIndex={active ? 0 : -1}
            aria-label={option.label}
            data-testid={`${testIdPrefix}-${option.id}`}
            onClick={() => onChange(option.id)}
            className={`inline-flex items-center gap-2 rounded-[var(--radius-button)] px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/40 ${
              active
                ? 'bg-surface-card text-brand-primary shadow-sm'
                : 'text-text-muted hover:text-text-heading'
            }`}
          >
            <Icon className="h-4 w-4" aria-hidden />
            <span className="hidden sm:inline" aria-hidden>
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

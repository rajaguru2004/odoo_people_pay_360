'use client';

import { useId, useState, type ReactNode } from 'react';
import { ChevronDown, Info } from 'lucide-react';
import { cn } from '@/utils/cn';

/**
 * The controls the settings sections are built from.
 *
 * Settings is a wall of small labelled fields, and the page is legible only if
 * every one of them is the same shape. These live here rather than inside a
 * section so the branding, attendance and people panels cannot drift into three
 * dialects of the same form.
 */

/** A switch with a real checkbox behind it, so it is reachable by keyboard. */
export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  /** The accessible name. Visible text beside the switch does not supply one. */
  label: string;
  disabled?: boolean;
}) {
  return (
    <label className="relative inline-flex shrink-0 cursor-pointer items-center">
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden
        className={cn(
          'h-6 w-11 rounded-[var(--radius-badge)] bg-surface-border transition-colors',
          'peer-checked:bg-brand-primary peer-disabled:opacity-50',
          'peer-focus-visible:ring-2 peer-focus-visible:ring-brand-primary/40',
          'after:absolute after:top-0.5 after:start-0.5 after:h-5 after:w-5 after:rounded-[var(--radius-badge)]',
          'after:bg-surface-card after:transition-transform peer-checked:after:translate-x-5',
          'rtl:peer-checked:after:-translate-x-5',
        )}
      />
    </label>
  );
}

/**
 * The explanation of a setting, on demand.
 *
 * A `title` rather than a hover card: these strings are long, they must survive
 * a touch device with no hover at all, and a tooltip that a screen reader cannot
 * reach is decoration.
 */
export function InfoHint({ text }: { text: string }) {
  return (
    <span className="inline-flex" title={text}>
      <Info className="h-3.5 w-3.5 text-text-muted" aria-hidden />
      <span className="sr-only">{text}</span>
    </span>
  );
}

/** A labelled row wrapping one control. The label is the control's own. */
export function Field({
  label,
  hint,
  description,
  children,
  className,
}: {
  label: string;
  hint?: string;
  description?: ReactNode;
  children: (id: string) => ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="flex items-center gap-1.5 text-sm font-medium text-text-body">
        {label}
        {hint && <InfoHint text={hint} />}
      </label>
      {children(id)}
      {description && <p className="text-xs text-text-muted">{description}</p>}
    </div>
  );
}

const CONTROL_CLASS =
  'w-full rounded-[var(--radius-input)] border border-surface-border bg-surface-card px-3 py-2 ' +
  'text-sm text-text-body placeholder:text-text-muted ' +
  'focus:outline-none focus:ring-2 focus:ring-brand-primary/40 disabled:opacity-60';

/** A text/number/time input bound to a `Field`. */
export function SettingInput({
  id,
  value,
  onChange,
  type = 'text',
  placeholder,
  disabled,
  step,
  min,
  max,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'number' | 'time' | 'url';
  placeholder?: string;
  disabled?: boolean;
  step?: string | number;
  min?: number;
  max?: number;
}) {
  return (
    <input
      id={id}
      type={type}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      step={step}
      min={min}
      max={max}
      onChange={(event) => onChange(event.target.value)}
      className={CONTROL_CLASS}
    />
  );
}

/** A colour picker beside the hex it produces, because admins paste hexes. */
export function ColorInput({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  // `<input type="color">` refuses anything that is not `#rrggbb` and silently
  // shows black instead, so the swatch is fed a known-good value while the text
  // field keeps whatever was typed.
  const swatch = /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#000000';

  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        value={swatch}
        disabled={disabled}
        aria-label="Colour picker"
        onChange={(event) => onChange(event.target.value)}
        className="h-9 w-12 shrink-0 cursor-pointer rounded-[var(--radius-input)] border border-surface-border bg-surface-card p-1 disabled:opacity-60"
      />
      <input
        id={id}
        type="text"
        value={value}
        disabled={disabled}
        placeholder="#00358F"
        onChange={(event) => onChange(event.target.value)}
        className={cn(CONTROL_CLASS, 'font-mono')}
      />
    </div>
  );
}

/** A row whose control is a switch: description on the start side, switch on the end. */
export function ToggleRow({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-[var(--radius-card)] border border-surface-border-light bg-surface-page px-3 py-2.5">
      <div className="min-w-0">
        <p className="text-sm font-medium text-text-heading">{label}</p>
        {description && <p className="mt-0.5 text-xs text-text-muted">{description}</p>}
      </div>
      <Toggle label={label} checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  );
}

/**
 * A collapsible panel grouping related settings.
 *
 * Headed by an `h3`: the page title is drawn by the shell from `usePageHeader`,
 * so these are the second level of the outline and a reader tabbing the
 * headings gets the list of groups rather than a flat run of labels.
 */
export function SectionCard({
  title,
  description,
  icon: Icon,
  children,
  action,
  defaultOpen = true,
  collapsible = true,
}: {
  title: string;
  description?: string;
  icon: React.ElementType;
  children: ReactNode;
  action?: ReactNode;
  defaultOpen?: boolean;
  collapsible?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  const shown = collapsible ? open : true;

  const heading = (
    <div className="flex min-w-0 items-center gap-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-button)] bg-status-info-bg text-status-info">
        <Icon className="h-4 w-4" aria-hidden />
      </span>
      <span className="min-w-0 text-start">
        <span className="block truncate text-sm font-semibold text-text-heading sm:text-base">
          {title}
        </span>
        {description && (
          <span className="mt-0.5 block text-xs text-text-muted">{description}</span>
        )}
      </span>
    </div>
  );

  return (
    <section className="surface-panel overflow-hidden">
      <h3 className="flex items-center gap-2 border-b border-surface-border-light px-4 py-3">
        {collapsible ? (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-controls={bodyId}
            className="flex flex-1 items-center justify-between gap-3 text-start"
          >
            {heading}
            <ChevronDown
              className={cn(
                'h-4 w-4 shrink-0 text-text-muted transition-transform',
                open && 'rotate-180',
              )}
              aria-hidden
            />
          </button>
        ) : (
          <span className="flex-1">{heading}</span>
        )}
        {action}
      </h3>
      {shown && (
        <div id={bodyId} className="space-y-4 p-4 sm:p-5">
          {children}
        </div>
      )}
    </section>
  );
}

/** ISO weekday numbers, 1 = Monday, in the order a week is read. */
export const WEEKDAYS = [
  { value: '1', label: 'Monday' },
  { value: '2', label: 'Tuesday' },
  { value: '3', label: 'Wednesday' },
  { value: '4', label: 'Thursday' },
  { value: '5', label: 'Friday' },
  { value: '6', label: 'Saturday' },
  { value: '7', label: 'Sunday' },
] as const;

/**
 * The weekly rest days, as a comma-separated list of ISO weekday numbers.
 *
 * Stored sorted so two administrators picking the same pair of days always
 * produce the same string, and a diff of the settings table stays readable.
 */
export function WeekdayPicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const selected = value.split(',').filter(Boolean);

  const toggle = (day: string) => {
    const next = selected.includes(day)
      ? selected.filter((entry) => entry !== day)
      : [...selected, day];
    onChange(next.sort().join(','));
  };

  return (
    <div className="flex flex-wrap gap-2">
      {WEEKDAYS.map((day) => {
        const active = selected.includes(day.value);
        return (
          <button
            key={day.value}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            onClick={() => toggle(day.value)}
            className={cn(
              'rounded-[var(--radius-button)] border px-3 py-1.5 text-xs font-medium transition-colors',
              'disabled:cursor-not-allowed disabled:opacity-60',
              active
                ? 'border-brand-primary bg-status-info-bg text-brand-primary'
                : 'border-surface-border bg-surface-card text-text-body hover:bg-surface-border-light',
            )}
          >
            {day.label}
          </button>
        );
      })}
    </div>
  );
}

/** A short banner for a setting whose current value deserves a word of warning. */
export function SettingNotice({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warning';
  children: ReactNode;
}) {
  return (
    <p
      className={cn(
        'rounded-[var(--radius-card)] border px-3 py-2.5 text-xs',
        tone === 'warning'
          ? 'border-status-warning/30 bg-status-warning-bg text-status-warning'
          : 'border-status-info/30 bg-status-info-bg text-status-info',
      )}
    >
      {children}
    </p>
  );
}

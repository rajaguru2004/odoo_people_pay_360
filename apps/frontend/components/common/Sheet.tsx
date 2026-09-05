'use client';

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/utils/cn';

/**
 * The app's overlay: a bottom sheet on a phone, the centred dialog it already
 * had at ≥768px.
 *
 * ## One tree, not two
 *
 * Every other mobile/desktop split in this pass is two subtrees behind
 * `md:hidden` / `hidden md:block`. An overlay must not be, and the reason is
 * concrete rather than aesthetic: Playwright's locators are strict, so a
 * duplicated form puts two nodes behind `getByTestId('reimb-amount')` and every
 * spec that drives it throws "resolved to 2 elements". A duplicated form also
 * means two copies of the same controlled React state, two file-input refs, and
 * a submit handler closed over whichever copy it happened to be defined in.
 *
 * The difference between the two shapes is four classes on two nodes:
 *
 *     overlay:  flex items-end justify-center   →  md:items-center md:p-4
 *     panel:    rounded-t-2xl max-h-[88svh]     →  md:rounded-2xl md:max-w-md
 *
 * `items-end` IS the bottom sheet. There is no JS branch, so there is no
 * first-render flash to design around.
 *
 * ## Three things this owns so 33 pages do not
 *
 * 1. **It portals to `document.body`.** A `motion` ancestor writes `transform`,
 *    and a transformed element becomes the containing block for `position:
 *    fixed` descendants — a sheet opened from inside an animated card would
 *    position against the card, not the viewport. Portalling is unconditional
 *    because "does an ancestor animate" is not knowable at the call site.
 *
 * 2. **It locks `<main>`, not `<body>`.** The usual `document.body.style.
 *    overflow = 'hidden'` is a NO-OP in this shell: `DashboardLayout` already
 *    sets `overflow-hidden` on the page shell and scrolls an inner `<main>`.
 *    Lock the wrong element and the page keeps scrolling under the reader's
 *    finger while the sheet sits still. This is the single most shell-specific
 *    behaviour in the kit, and the clearest reason it is written once.
 *
 * 3. **Escape, backdrop, focus trap, and the dialog role.** None of the 46
 *    hand-rolled `fixed inset-0` overlays this replaces do any of it.
 *
 * ## DOM depth is load-bearing
 *
 * `e2e/pages/travel.ts` reaches the confirm panel by walking two ancestors up
 * from the confirm button (button → footer → panel). `ConfirmModal` is built on
 * this component, so **footer children must stay direct children of the footer
 * element**. Wrapping them in one more div silently breaks that page object.
 */

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  /**
   * Required. It is the accessible name — a dialog without one is announced as
   * just "dialog", which is no help at all to a screen reader.
   */
  title: string;
  /** Optional glyph beside the title, matching the confirm dialog's layout. */
  icon?: ReactNode;
  /** Right of the title, before the close button. Usually a status chip. */
  titleRight?: ReactNode;
  /**
   * Pinned under the scroll area, safe-area padded. Buttons here should be
   * `h-12` — this is the bottom of the screen, where the thumb is.
   */
  footer?: ReactNode;
  /** `md` = `max-w-md` at ≥768px (the current dialog width); `lg` = `max-w-2xl` for forms. */
  size?: 'md' | 'lg';
  /** A sheet opened from inside another sheet. Moves it up one rung, to z-[70]. */
  nested?: boolean;
  /** Hides the close button — for a sheet the reader must answer. */
  hideClose?: boolean;
  /** Root id. Convention: `<domain>-sheet`. */
  testId?: string;
  className?: string;
  children: ReactNode;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function Sheet({
  open,
  onClose,
  title,
  icon,
  titleRight,
  footer,
  size = 'md',
  nested = false,
  hideClose = false,
  testId,
  className,
  children,
}: SheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [mounted, setMounted] = useState(false);

  // `document` does not exist during SSR, and createPortal needs a real node.
  useEffect(() => setMounted(true), []);

  /**
   * Scroll-lock the element that actually scrolls.
   *
   * Restores the previous inline value rather than clearing it, so a nested
   * sheet closing does not unlock the page while its parent is still open.
   */
  useEffect(() => {
    if (!open) return;
    const main = document.querySelector('main');
    if (!main) return;
    const previous = main.style.overflow;
    main.style.overflow = 'hidden';
    return () => {
      main.style.overflow = previous;
    };
  }, [open]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      // Focus trap. Without it, Tab walks out of the sheet and into the page
      // behind it, which is still fully interactive to a keyboard.
      const nodes = panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!nodes || nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  // Move focus in on open, so the trap has something to trap and a screen
  // reader lands inside the dialog rather than at the top of the page.
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      const target =
        panelRef.current?.querySelector<HTMLElement>(FOCUSABLE) ?? panelRef.current;
      target?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  if (!open || !mounted) return null;

  return createPortal(
    <div
      // `items-end` on a phone, centred at ≥768px — this one line is the whole
      // difference between a bottom sheet and the dialog this app had.
      className={cn(
        'fixed inset-0 flex items-end justify-center bg-black/50 animate-fade-in md:items-center md:p-4',
        nested ? 'z-[70]' : 'z-[60]',
      )}
      onMouseDown={(event) => {
        // mousedown, not click: a click that STARTED inside the panel and ended
        // on the backdrop (a drag off a slider, a text selection) would close
        // the sheet and throw away what the reader typed.
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={onKeyDown}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
        tabIndex={-1}
        className={cn(
          'sheet-panel-enter flex w-full max-h-[88svh] flex-col overflow-hidden rounded-t-2xl',
          'border border-surface-border bg-surface-overlay shadow-2xl outline-none',
          'md:max-h-[90vh] md:rounded-2xl',
          size === 'lg' ? 'md:max-w-2xl' : 'md:max-w-md',
          className,
        )}
      >
        {/* Grab handle — the affordance that says "this pulls up from the
            bottom". Decorative, and desktop never sees it. */}
        <div className="flex justify-center pt-2 md:hidden" aria-hidden="true">
          <span className="h-1 w-10 rounded-full bg-surface-border" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-surface-border p-4 md:p-6">
          <div className="flex min-w-0 items-center gap-3">
            {icon}
            <h3 id={titleId} className="truncate text-lg font-semibold text-text-heading">
              {title}
            </h3>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {titleRight}
            {!hideClose && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                data-testid={testId ? `${testId}-close` : undefined}
                className="inline-flex h-11 w-11 touch-manipulation items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface-page hover:text-text-body"
              >
                <X className="h-5 w-5" />
              </button>
            )}
          </div>
        </div>

        {/* Body — `overscroll-contain` stops a flick at the end of this list
            from chaining into the page behind the sheet. */}
        <div className="flex-1 overflow-y-auto overscroll-contain p-4 md:p-6">{children}</div>

        {/*
          Footer. Its children are the buttons themselves, with no wrapper —
          `e2e/pages/travel.ts` walks button → footer → panel to find the dialog.
        */}
        {footer && (
          <div className="flex items-center justify-end gap-3 border-t border-surface-border bg-surface-page px-4 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))] md:rounded-b-2xl md:p-6">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

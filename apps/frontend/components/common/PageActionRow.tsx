'use client';

import { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowLeftIcon } from '@/components/common/icons/directional';
import BreadcrumbTrail from '@/components/common/BreadcrumbTrail';
import type { Crumb } from '@/store/pageHeaderStore';

export type { Crumb };

interface PageActionRowProps {
  breadcrumbs?: Crumb[];
  /** Renders a back button ahead of the trail. */
  onBack?: () => void;
  /**
   * Overrides the back button's label. Defaults to the shared `common.back`
   * string — pass this only when the page has its own more specific wording
   * (e.g. "Back to Bank Master"), and pass it already translated.
   */
  backLabel?: string;
  /** Primary action(s), pushed to the far end of the row. */
  action?: ReactNode;
}

/**
 * The slim row a dashboard page puts above its content: breadcrumb trail on the
 * inline-start, actions on the inline-end.
 *
 * This deliberately renders NO title or subtitle. The dashboard has exactly one
 * heading slot and it lives in TopHeader — pages feed it through
 * `usePageHeader`. Rendering a heading here as well was the duplicate-title
 * defect this component was introduced to remove.
 *
 * With no breadcrumbs, no back button and no action there is nothing to show, so
 * it renders nothing rather than an empty box holding dead vertical space.
 */
export default function PageActionRow({ breadcrumbs, onBack, backLabel, action }: PageActionRowProps) {
  const tc = useTranslations('common');
  const hasTrail = Boolean(onBack || (breadcrumbs && breadcrumbs.length > 0));
  if (!hasTrail && !action) return null;

  // Never a bare English literal: the back control is the one piece of chrome
  // this component owns, and the app has a live Arabic locale.
  const backText = backLabel ?? tc('back');

  return (
    // Wraps on a phone rather than forcing the row wider than the screen: an
    // action that says `w-full` (which is what a primary action should say on a
    // phone) cannot honour it while sharing a row with a back button and a
    // trail. `min-w-0` on both halves so a long crumb truncates instead of
    // pushing.
    <div className="flex flex-wrap items-center justify-between gap-3 md:flex-nowrap md:gap-4">
      <div className="flex items-center gap-3 min-w-0">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            title={backText}
            aria-label={backText}
            className="flex items-center justify-center gap-1.5 min-w-11 md:min-w-0 ps-2 pe-2.5 py-2 rounded-[--radius-button] border border-surface-border text-text-muted hover:bg-surface-page hover:text-text-heading transition-colors shrink-0 touch-manipulation"
          >
            <ArrowLeftIcon size={18} />
            <span className="text-sm font-medium hidden sm:inline">{backText}</span>
          </button>
        )}

        {breadcrumbs && breadcrumbs.length > 0 && <BreadcrumbTrail crumbs={breadcrumbs} />}
      </div>

      {action && <div className="flex w-full min-w-0 items-center gap-2 md:w-auto md:shrink-0">{action}</div>}
    </div>
  );
}

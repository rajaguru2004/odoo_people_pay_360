'use client';

import Link from 'next/link';
import { ChevronRightIcon } from '@/components/common/icons/directional';
import type { Crumb } from '@/store/pageHeaderStore';

export type { Crumb };

interface BreadcrumbTrailProps {
  crumbs: Crumb[];
  /**
   * `header` is the condensed variant that sits above the title in TopHeader,
   * where the whole row is 64px tall; `page` is the in-content size used by
   * PageActionRow.
   */
  variant?: 'page' | 'header';
  className?: string;
}

/**
 * The breadcrumb trail itself, with no opinion about where it sits.
 *
 * Two callers: PageActionRow (in-content, beside a page's actions) and
 * TopHeader (above the single heading slot). They render the same markup so a
 * page that declares its own trail and a page that gets the derived one look
 * identical.
 */
export default function BreadcrumbTrail({ crumbs, variant = 'page', className = '' }: BreadcrumbTrailProps) {
  if (!crumbs.length) return null;

  const isHeader = variant === 'header';
  const textSize = isHeader ? 'text-[11px]' : 'text-sm';
  const chevronSize = isHeader ? 12 : 14;

  return (
    <nav
      aria-label="Breadcrumb"
      className={`flex items-center gap-1.5 ${textSize} min-w-0 ${className}`}
    >
      {crumbs.map((crumb, i) => {
        const isLast = i === crumbs.length - 1;
        return (
          <span key={`${crumb.label}-${i}`} className="flex items-center gap-1.5 min-w-0">
            {i > 0 && <ChevronRightIcon size={chevronSize} className="text-text-muted shrink-0" />}
            {crumb.href && !isLast ? (
              <Link
                href={crumb.href}
                // `min-h-11` below md only. A crumb is a 20px-tall text link,
                // which is fine for a mouse and is the single most repeated
                // sub-44px target in the portal — `PageBreadcrumbs` renders on
                // every dashboard route, so one fix here clears ~35 screens.
                // The row's own height is unchanged at ≥768px.
                className="inline-flex min-h-11 md:min-h-0 items-center text-text-muted hover:text-text-heading transition-colors truncate touch-manipulation"
              >
                {crumb.label}
              </Link>
            ) : (
              <span
                className={isLast ? 'font-semibold text-text-heading truncate' : 'text-text-muted truncate'}
                aria-current={isLast ? 'page' : undefined}
              >
                {crumb.label}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}

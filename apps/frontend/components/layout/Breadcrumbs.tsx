'use client';

import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { usePageChrome } from '@/hooks/usePageChrome';

/**
 * The trail, from the module down to the page.
 *
 * Sits at the top of the CONTENT area rather than in the header bar. The bar is
 * fixed chrome shared by every screen — identity, the heading, sign-out — and a
 * trail belongs to the page under it, not to the frame around it. Putting it in
 * the bar also squeezed it above the heading in a 64px row, where it read as a
 * caption on the title instead of as a route.
 *
 * Rooted at the module rather than at the main dashboard: from inside People the
 * useful way back is the People hub, and the dashboard is already one click away
 * in the rail.
 */
export default function Breadcrumbs() {
  const { crumbs } = usePageChrome();

  if (!crumbs.length) return null;

  return (
    <nav
      aria-label="Breadcrumb"
      className="mb-4 flex min-w-0 flex-wrap items-center gap-1.5 text-xs"
    >
      {crumbs.map((crumb, i) => {
        const isLast = i === crumbs.length - 1;
        return (
          <span key={`${crumb.label}-${i}`} className="flex min-w-0 items-center gap-1.5">
            {i > 0 && (
              <ChevronRight
                className="h-3.5 w-3.5 shrink-0 text-text-muted rtl:rotate-180"
                aria-hidden
              />
            )}
            {crumb.href && !isLast ? (
              <Link
                href={crumb.href}
                className="truncate text-text-muted transition-colors hover:text-brand-primary"
              >
                {crumb.label}
              </Link>
            ) : (
              // The page you are standing on: not a link, and carried in the
              // body colour so the trail reads as ending here.
              <span aria-current="page" className="truncate font-medium text-text-body">
                {crumb.label}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}

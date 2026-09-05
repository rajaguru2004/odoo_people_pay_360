'use client';

import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
} from '@/components/common/icons/directional';

/**
 * Shared by every control here: 44×44 is the floor a thumb can hit reliably
 * (Apple HIG / WCAG 2.5.5), and the pager was below it at `h-9` / `p-2`.
 */
const CONTROL =
  'inline-flex h-11 w-11 items-center justify-center rounded-lg border border-surface-border ' +
  'text-text-body transition-colors hover:bg-surface-page touch-manipulation ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

interface PaginationProps {
  /**
   * Optional test-id namespace. Several screens mount a pager, and Playwright's
   * getByTestId matches across the whole page — so a shared, unprefixed id
   * would resolve to whichever pager rendered first. Screens that are driven by
   * a spec pass their own prefix (the attendance overview passes `att-pg`).
   */
  testIdPrefix?: string;
  currentPage: number;
  totalPages: number;
  totalItems: number;
  itemsPerPage: number;
  onPageChange: (page: number) => void;
  onItemsPerPageChange?: (itemsPerPage: number) => void;
}

export default function Pagination({
  currentPage,
  totalPages,
  totalItems,
  itemsPerPage,
  onPageChange,
  testIdPrefix,
  onItemsPerPageChange,
}: PaginationProps) {
  const startItem = (currentPage - 1) * itemsPerPage + 1;
  const endItem = Math.min(currentPage * itemsPerPage, totalItems);

  const getPageNumbers = () => {
    const pages: (number | string)[] = [];
    const maxVisible = 5;

    if (totalPages <= maxVisible) {
      for (let i = 1; i <= totalPages; i++) {
        pages.push(i);
      }
    } else {
      if (currentPage <= 3) {
        for (let i = 1; i <= 4; i++) pages.push(i);
        pages.push('...');
        pages.push(totalPages);
      } else if (currentPage >= totalPages - 2) {
        pages.push(1);
        pages.push('...');
        for (let i = totalPages - 3; i <= totalPages; i++) pages.push(i);
      } else {
        pages.push(1);
        pages.push('...');
        for (let i = currentPage - 1; i <= currentPage + 1; i++) pages.push(i);
        pages.push('...');
        pages.push(totalPages);
      }
    }
    return pages;
  };

  return (
    <div className="flex flex-col sm:flex-row items-center justify-between gap-3 sm:gap-4 px-4 py-3 md:px-6 md:py-4 bg-surface-page border-t border-surface-border">
      {/* Items info */}
      <div className="flex items-center gap-4">
        <p className="text-xs md:text-sm text-text-muted">
          Display <span className="font-semibold text-text-heading">{startItem}</span> to{' '}
          <span className="font-semibold text-text-heading">{endItem}</span> in total{' '}
          <span className="font-semibold text-text-heading">{totalItems}</span> records
        </p>
        
        {/* Items per page selector */}
        {onItemsPerPageChange && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-text-muted">Display:</span>
            <select
              value={itemsPerPage}
              onChange={(e) => onItemsPerPageChange(Number(e.target.value))}
              className="px-2 py-1 border border-surface-border bg-surface-card text-text-body rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary"
            >
              <option value={10}>10</option>
              <option value={20}>20</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
          </div>
        )}
      </div>

      {/*
        Pagination controls.

        Prev and Next are ONE pair at every width, deliberately: duplicating
        them into a phone strip and a desktop strip would put two nodes behind
        `${testIdPrefix}-prev`, and Playwright's locators are strict — every
        spec that drives a pager would throw "resolved to 2 elements". Only the
        parts that have no phone form are hidden: first/last, and the numbered
        strip, which at 5 numbers plus 4 arrows needs 396px and cannot fit a
        390px screen. The phone gets a "Page N of M" label in their place.
      */}
      <div className="flex items-center gap-2">
        {/* First page */}
        <button
          data-testid={testIdPrefix ? `${testIdPrefix}-first` : undefined}
          onClick={() => onPageChange(1)}
          disabled={currentPage === 1}
          className={`hidden md:inline-flex ${CONTROL}`}
          title="First page"
        >
          <ChevronsLeftIcon size={16} />
        </button>

        {/* Previous page */}
        <button
          data-testid={testIdPrefix ? `${testIdPrefix}-prev` : undefined}
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage === 1}
          className={CONTROL}
          title="Previous page"
        >
          <ChevronLeftIcon size={16} />
        </button>

        {/* Page numbers — desktop */}
        <div className="hidden md:flex items-center gap-1">
          {getPageNumbers().map((page, index) => (
            <button
              data-testid={testIdPrefix ? `${testIdPrefix}-page-${page}` : undefined}
              data-active={page === currentPage}
              key={index}
              onClick={() => typeof page === 'number' && onPageChange(page)}
              disabled={page === '...'}
              className={`min-w-[44px] h-11 px-3 rounded-lg text-sm font-medium transition-colors ${
                page === currentPage
                  ? 'bg-brand-primary text-text-on-brand'
                  : page === '...'
                  ? 'cursor-default text-text-muted'
                  : 'border border-surface-border text-text-body hover:bg-surface-page'
              }`}
            >
              {page}
            </button>
          ))}
        </div>

        {/* Page position — phone */}
        <span
          data-testid={testIdPrefix ? `${testIdPrefix}-page-label` : undefined}
          className="md:hidden px-2 text-sm font-medium tabular-nums text-text-body"
        >
          {currentPage} / {totalPages}
        </span>

        {/* Next page */}
        <button
          data-testid={testIdPrefix ? `${testIdPrefix}-next` : undefined}
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage === totalPages}
          className={CONTROL}
          title="Next page"
        >
          <ChevronRightIcon size={16} />
        </button>

        {/* Last page */}
        <button
          data-testid={testIdPrefix ? `${testIdPrefix}-last` : undefined}
          onClick={() => onPageChange(totalPages)}
          disabled={currentPage === totalPages}
          className={`hidden md:inline-flex ${CONTROL}`}
          title="Last page"
        >
          <ChevronsRightIcon size={16} />
        </button>
      </div>
    </div>
  );
}

// App constants
export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || 'People Pay 360';
export const APP_SHORT_NAME = 'PP360';
export const APP_VERSION = '1.0.0';

// API
export const API_TIMEOUT = 30000;

// Pagination
export const DEFAULT_PAGE_SIZE = 20;
export const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

// Date formats
export const DATE_FORMAT = 'dd/MM/yyyy';
export const DATETIME_FORMAT = 'dd/MM/yyyy HH:mm';
export const TIME_FORMAT = 'HH:mm';
export const MONTH_YEAR_FORMAT = 'MM/yyyy';

// Employee status
export const EMPLOYEE_STATUS = {
  ACTIVE: { label: 'Active', color: 'green' },
  ON_LEAVE: { label: 'On Leave', color: 'blue' },
  SUSPENDED: { label: 'Suspended', color: 'orange' },
  TERMINATED: { label: 'Terminated', color: 'red' },
} as const;

// Payroll run status
export const PAYROLL_RUN_STATUS = {
  DRAFT: { label: 'Draft', color: 'gray' },
  CALCULATED: { label: 'Calculated', color: 'blue' },
  APPROVED: { label: 'Approved', color: 'green' },
  PAID: { label: 'Paid', color: 'emerald' },
  CANCELLED: { label: 'Cancelled', color: 'red' },
} as const;

/**
 * Minor units per currency.
 *
 * The Gulf currencies this platform is built for are THOUSANDTHS, not
 * hundredths. Formatting OMR with two decimals silently rounds every amount to
 * the nearest 10 baisa, and a payroll that rounds does not reconcile.
 */
export const CURRENCY_DECIMALS: Record<string, number> = {
  OMR: 3,
  KWD: 3,
  BHD: 3,
  AED: 2,
  SAR: 2,
  QAR: 2,
  USD: 2,
  EUR: 2,
  INR: 2,
};

export const DEFAULT_CURRENCY_DECIMALS = 2;

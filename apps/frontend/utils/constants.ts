// App constants
export const APP_NAME = 'Ess Portal - Employee Self-Service';
export const APP_SHORT_NAME = 'Ess Portal';
export const APP_VERSION = '1.0.0';

// API
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3002';
export const API_TIMEOUT = 30000;

// Pagination
export const DEFAULT_PAGE_SIZE = 10;
export const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

// Date formats
export const DATE_FORMAT = 'dd/MM/yyyy';
export const DATETIME_FORMAT = 'dd/MM/yyyy HH:mm';
export const TIME_FORMAT = 'HH:mm';
export const MONTH_YEAR_FORMAT = 'MM/yyyy';

// Employee status
export const EMPLOYEE_STATUS = {
  ACTIVE: { label: 'Active', color: 'green' },
  INACTIVE: { label: 'Inactive', color: 'gray' },
  ON_LEAVE: { label: 'On Leave', color: 'blue' },
  TERMINATED: { label: 'Terminated', color: 'red' },
} as const;

// Gender
export const GENDER = {
  MALE: { label: 'Male', icon: '♂' },
  FEMALE: { label: 'Female', icon: '♀' },
  OTHER: { label: 'Other', icon: '⚧' },
} as const;

// Leave types
export const LEAVE_TYPE = {
  ANNUAL: { label: 'Annual Leave', color: 'blue', maxDays: 12 },
  SICK: { label: 'Sick Leave', color: 'orange', maxDays: 30 },
  UNPAID: { label: 'Unpaid Leave', color: 'gray', maxDays: 365 },
  MATERNITY: { label: 'Maternity Leave', color: 'pink', maxDays: 180 },
  MARRIAGE: { label: 'Marriage Leave', color: 'purple', maxDays: 3 },
  BEREAVEMENT: { label: 'Bereavement Leave', color: 'black', maxDays: 3 },
} as const;

// Leave status
export const LEAVE_STATUS = {
  PENDING: { label: 'Pending', color: 'yellow' },
  APPROVED: { label: 'Approved', color: 'green' },
  REJECTED: { label: 'Rejected', color: 'red' },
  CANCELLED: { label: 'Cancelled', color: 'gray' },
} as const;

// Overtime status
export const OVERTIME_STATUS = {
  PENDING: { label: 'Pending', color: 'yellow' },
  APPROVED: { label: 'Approved', color: 'green' },
  REJECTED: { label: 'Rejected', color: 'red' },
  CANCELLED: { label: 'Cancelled', color: 'gray' },
} as const;

// Contract types
export const CONTRACT_TYPE = {
  PROBATION: { label: 'Probation', duration: '2 months' },
  FIXED_TERM: { label: 'Fixed Term', duration: '1-3 years' },
  INDEFINITE: { label: 'Indefinite', duration: 'Permanent' },
} as const;

// Contract status
export const CONTRACT_STATUS = {
  ACTIVE: { label: 'Active', color: 'green' },
  EXPIRED: { label: 'Expired', color: 'red' },
  TERMINATED: { label: 'Terminated', color: 'gray' },
} as const;

// Payroll status
export const PAYROLL_STATUS = {
  DRAFT: { label: 'Draft', color: 'gray' },
  FINALIZED: { label: 'Finalized', color: 'green' },
} as const;

// Reward types
export const REWARD_TYPE = {
  BONUS: { label: 'Cash Bonus', icon: '💰' },
  CERTIFICATE: { label: 'Certificate', icon: '📜' },
  GIFT: { label: 'Gift', icon: '🎁' },
  OTHER: { label: 'Other', icon: '⭐' },
} as const;

// Discipline types
export const DISCIPLINE_TYPE = {
  WARNING: { label: 'Warning', severity: 'low' },
  SUSPENSION: { label: 'Suspension', severity: 'medium' },
  FINE: { label: 'Fine', severity: 'medium' },
  TERMINATION: { label: 'Dismissal', severity: 'high' },
  OTHER: { label: 'Other', severity: 'low' },
} as const;

// Salary component types
export const COMPONENT_TYPE = {
  ALLOWANCE: { label: 'Allowance', sign: '+' },
  BONUS: { label: 'Bonus', sign: '+' },
  DEDUCTION: { label: 'Deduction', sign: '-' },
  INSURANCE: { label: 'Insurance', sign: '-' },
  TAX: { label: 'Tax', sign: '-' },
  OVERTIME: { label: 'Overtime', sign: '+' },
  COMMISSION: { label: 'Commission', sign: '+' },
  OTHER: { label: 'Other', sign: '±' },
} as const;

// User roles
export const USER_ROLE = {
  ADMIN: { label: 'Admin', color: 'red' },
  HR_MANAGER: { label: 'HR Manager', color: 'blue' },
  MANAGER: { label: 'Manager', color: 'green' },
  EMPLOYEE: { label: 'Employee', color: 'gray' },
} as const;

// Work time
export const WORK_START_TIME = '08:00';
export const WORK_END_TIME = '17:00';
export const STANDARD_WORK_HOURS = 8;

// Overtime limits
export const OVERTIME_MAX_HOURS_PER_DAY = 12;
export const OVERTIME_MAX_HOURS_PER_MONTH = 30;
export const OVERTIME_MAX_HOURS_PER_YEAR = 200;

// Insurance
export const INSURANCE_CAP = 36000000; // 36M INR
export const SOCIAL_INSURANCE_RATE = 0.08; // 8%
export const HEALTH_INSURANCE_RATE = 0.015; // 1.5%
export const UNEMPLOYMENT_INSURANCE_RATE = 0.01; // 1%

// Tax brackets (Vietnam 2024)
export const TAX_BRACKETS = [
  { from: 0, to: 5000000, rate: 0.05 },
  { from: 5000000, to: 10000000, rate: 0.10 },
  { from: 10000000, to: 18000000, rate: 0.15 },
  { from: 18000000, to: 32000000, rate: 0.20 },
  { from: 32000000, to: 52000000, rate: 0.25 },
  { from: 52000000, to: 80000000, rate: 0.30 },
  { from: 80000000, to: Infinity, rate: 0.35 },
];

export const PERSONAL_DEDUCTION = 11000000; // 11M INR
export const DEPENDENT_DEDUCTION = 4400000; // 4.4M INR

// File upload
export const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/jpg'];
export const ALLOWED_DOCUMENT_TYPES = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];

// Toast duration
export const TOAST_DURATION = 3000;

// Colors
export const COLORS = {
  primary: '#00358F',
  secondary: '#f66600',
  accent: '#AECCFF',
  success: '#10b981',
  warning: '#f59e0b',
  error: '#ef4444',
  info: '#3b82f6',
} as const;

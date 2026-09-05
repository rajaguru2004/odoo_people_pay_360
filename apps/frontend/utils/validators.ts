import { z } from 'zod';

// Email validator
export const emailSchema = z.string().email('Invalid email');

// Password validator
export const passwordSchema = z
  .string()
  .min(6, 'Password must be at least 6 characters')
  .regex(/[A-Z]/, 'Password must have at least 1 uppercase letter')
  .regex(/[a-z]/, 'Password must have at least 1 lowercase letter')
  .regex(/[0-9]/, 'Password must have at least 1 number');

// Phone validator (Vietnam)
export const phoneSchema = z
  .string()
  .regex(/^(0|\+84)[0-9]{9}$/, 'Invalid phone number');

// ID Card validator (Vietnam CCCD 12 digits)
export const idCardSchema = z
  .string()
  .regex(/^[0-9]{12}$/, 'ID card number must be 12 digits');

// Date validators
export const dateSchema = z.string().refine((date) => {
  return !isNaN(Date.parse(date));
}, 'Invalid date');

export const futureDateSchema = z.string().refine((date) => {
  return new Date(date) > new Date();
}, 'Date must be after the current date');

export const pastDateSchema = z.string().refine((date) => {
  return new Date(date) < new Date();
}, 'Date must be before the current date');

// Age validator (18+)
export const dateOfBirthSchema = z.string().refine((date) => {
  const age = new Date().getFullYear() - new Date(date).getFullYear();
  return age >= 18;
}, 'Employees must be 18 years of age or older');

// Salary validator
export const salarySchema = z
  .number()
  .min(0, 'Salary must be greater than 0')
  .max(1000000000, 'Invalid salary');

// Work hours validator
export const workHoursSchema = z
  .number()
  .min(0, 'Invalid working hours')
  .max(24, 'Working hours cannot exceed 24 hours');

// Overtime hours validator
export const overtimeHoursSchema = z
  .number()
  .min(0.5, 'Minimum overtime 0.5 hours')
  .max(12, 'Overtime must not exceed 12 hours/day');

// Leave days validator
export const leaveDaysSchema = z
  .number()
  .min(0.5, 'Minimum leave of 0.5 days')
  .max(30, 'Leave cannot exceed 30 days');

// Date range validator
export const dateRangeSchema = z.object({
  startDate: z.string(),
  endDate: z.string(),
}).refine((data) => {
  return new Date(data.endDate) >= new Date(data.startDate);
}, {
  message: 'The end date must be after the start date',
  path: ['endDate'],
});

// Time range validator
export const timeRangeSchema = z.object({
  startTime: z.string(),
  endTime: z.string(),
}).refine((data) => {
  const start = new Date(`2000-01-01 ${data.startTime}`);
  const end = new Date(`2000-01-01 ${data.endTime}`);
  return end > start;
}, {
  message: 'The ending time must be after the starting time',
  path: ['endTime'],
});

// Helper functions
export const isValidEmail = (email: string): boolean => {
  return emailSchema.safeParse(email).success;
};

export const isValidPhone = (phone: string): boolean => {
  return phoneSchema.safeParse(phone).success;
};

export const isValidIdCard = (idCard: string): boolean => {
  return idCardSchema.safeParse(idCard).success;
};

export const calculateAge = (dateOfBirth: string): number => {
  const today = new Date();
  const birthDate = new Date(dateOfBirth);
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();
  
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }
  
  return age;
};

/**
 * @deprecated Assumes a fixed Sat/Sun weekend and ignores holidays + per-branch
 * weekly-off days. For anything user-facing that must match payroll/leave, use
 * the backend engine via `holidayService.calculateWorkDays(month, year, branchId)`.
 */
export const isWeekend = (date: Date): boolean => {
  const day = date.getDay();
  return day === 0 || day === 6; // Sunday or Saturday
};

/** @deprecated Weekend/holiday-blind. See `holidayService.calculateWorkDays`. */
export const calculateWorkDays = (startDate: Date, endDate: Date): number => {
  let count = 0;
  const current = new Date(startDate);
  
  while (current <= endDate) {
    if (!isWeekend(current)) {
      count++;
    }
    current.setDate(current.getDate() + 1);
  }
  
  return count;
};

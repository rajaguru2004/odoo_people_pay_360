export interface HolidayBranchRef {
  id: string;
  code: string;
  name: string;
}

export interface Holiday {
  id: string;
  name: string;
  date: string;
  year: number;
  isRecurring: boolean;
  branchId: string | null; // null = applies to all branches (company-wide)
  description?: string | null;
  branch?: HolidayBranchRef | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateHolidayData {
  name: string;
  date: string;
  year?: number;
  isRecurring?: boolean;
  branchId?: string | null;
  description?: string | null;
}

export type UpdateHolidayData = Partial<CreateHolidayData>;

export interface CopyYearData {
  fromYear: number;
  toYear: number;
  branchId?: string;
  onlyRecurring?: boolean;
}

export interface CopyYearResult {
  created: number;
  skipped: number;
  total: number;
}

// Matches the enriched backend GET /holidays/work-days/:month/:year response.
export interface WorkDaysCalculation {
  month: number;
  year: number;
  branchId: string | null;
  totalDays: number;
  workDays: number;
  weekends: number;
  holidays: number;
  holidayList: Holiday[];
}

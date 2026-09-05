export type CalendarEventType = 'work' | 'leave' | 'overtime' | 'holiday';

export interface CalendarEvent {
  id: string;
  title: string;
  /** Wall clock, never an instant: `2026-09-05` or `2026-09-05T08:00:00`. */
  startDate: string;
  endDate: string;
  type: CalendarEventType;
  allDay: boolean;
  description: string | null;
  shiftType?: string;
  startTime?: string | null;
  endTime?: string | null;
  requiredHours?: number | null;
}

export interface CalendarStats {
  workDays: number;
  leaveDays: number;
  overtimeHours: number;
  holidays: number;
}

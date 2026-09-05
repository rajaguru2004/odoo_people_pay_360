'use client';

import { CalendarDays, Clock, MapPin } from 'lucide-react';
import {
  Field,
  SectionCard,
  SettingInput,
  SettingNotice,
  WeekdayPicker,
} from './SettingsPrimitives';

/** The keys this section owns. The save bar patches exactly these. */
export const ATTENDANCE_KEYS = [
  'attendance_office_start',
  'attendance_office_end',
  'attendance_grace_minutes',
  'attendance_weekly_off_days',
  'attendance_half_day_threshold',
  'attendance_day_end',
  'attendance_geofence_default_radius_m',
] as const;

/** `HH:mm` as minutes past midnight, or null when it is not a time at all. */
function minutesOf(value: string | undefined): number | null {
  const [hours, minutes] = (value ?? '').split(':').map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

export function AttendanceSection({
  values,
  onChange,
  disabled,
}: {
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  disabled?: boolean;
}) {
  const dayEnd = values.attendance_day_end ?? '';
  const officeEnd = values.attendance_office_end ?? '';

  const dayEndMinutes = minutesOf(dayEnd);
  const officeEndMinutes = minutesOf(officeEnd);

  // Below noon the boundary is read as the NEXT morning, which is how a night
  // shift keeps its hours on the day it started.
  const closesNextMorning = dayEndMinutes !== null && dayEndMinutes < 12 * 60;

  // A boundary that lands inside the working day closes sessions that are still
  // legitimately open, so it is worth saying before it is saved rather than
  // after the first day of truncated timesheets.
  const boundaryInsideOfficeHours =
    dayEndMinutes !== null &&
    officeEndMinutes !== null &&
    !closesNextMorning &&
    dayEndMinutes < officeEndMinutes;

  const threshold = Number(values.attendance_half_day_threshold);
  const thresholdPercent = Number.isFinite(threshold) ? Math.round(threshold * 100) : null;

  return (
    <div className="space-y-4 sm:space-y-5">
      <SectionCard
        title="Office hours"
        description="The window a working day is measured against"
        icon={Clock}
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="Office start">
            {(id) => (
              <SettingInput
                id={id}
                type="time"
                value={values.attendance_office_start ?? ''}
                onChange={(value) => onChange('attendance_office_start', value)}
                disabled={disabled}
              />
            )}
          </Field>

          <Field label="Office end">
            {(id) => (
              <SettingInput
                id={id}
                type="time"
                value={officeEnd}
                onChange={(value) => onChange('attendance_office_end', value)}
                disabled={disabled}
              />
            )}
          </Field>

          <Field
            label="Grace period (minutes)"
            hint="A check-in this many minutes after the office start is still on time."
          >
            {(id) => (
              <SettingInput
                id={id}
                type="number"
                min={0}
                value={values.attendance_grace_minutes ?? ''}
                onChange={(value) => onChange('attendance_grace_minutes', value)}
                disabled={disabled}
              />
            )}
          </Field>
        </div>

        <SettingNotice>
          These are wall-clock times in the company timezone, and a branch may
          override any of the three for its own staff.
        </SettingNotice>
      </SectionCard>

      <SectionCard
        title="The working week"
        description="Which days are rest days, and what counts as a full day worked"
        icon={CalendarDays}
      >
        <Field
          label="Weekly rest days"
          description="Nobody is marked absent on a rest day. A branch with a different week overrides this for its own staff."
        >
          {() => (
            <WeekdayPicker
              value={values.attendance_weekly_off_days ?? ''}
              onChange={(value) => onChange('attendance_weekly_off_days', value)}
              disabled={disabled}
            />
          )}
        </Field>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field
            label="Half-day threshold"
            hint="A fraction of the expected hours, between 0 and 1. Below it the day is recorded as a half day rather than present."
            description={
              thresholdPercent === null
                ? 'Enter a fraction between 0 and 1.'
                : `A day under ${thresholdPercent}% of the expected hours is recorded as a half day.`
            }
          >
            {(id) => (
              <SettingInput
                id={id}
                type="number"
                step="0.05"
                min={0}
                max={1}
                value={values.attendance_half_day_threshold ?? ''}
                onChange={(value) => onChange('attendance_half_day_threshold', value)}
                disabled={disabled}
              />
            )}
          </Field>

          <Field
            label="Day end"
            hint="When the attendance day closes: absences are settled and any session still open is closed."
            description={
              dayEndMinutes === null
                ? undefined
                : closesNextMorning
                  ? `The day closes at ${dayEnd} the next morning, so overnight hours count towards the day the shift started.`
                  : `The day closes the same evening at ${dayEnd}.`
            }
          >
            {(id) => (
              <SettingInput
                id={id}
                type="time"
                value={dayEnd}
                onChange={(value) => onChange('attendance_day_end', value)}
                disabled={disabled}
              />
            )}
          </Field>
        </div>

        {boundaryInsideOfficeHours && (
          <SettingNotice tone="warning">
            The day end falls before the office end. Anyone still checked in at{' '}
            {dayEnd} is closed out immediately — set it after the office ends, or
            after midnight, unless that is what you want.
          </SettingNotice>
        )}
      </SectionCard>

      <SectionCard
        title="Geofence"
        description="How close to a branch a punch has to be recorded from"
        icon={MapPin}
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field
            label="Default radius (metres)"
            hint="Applied to a branch that has not set its own. A branch radius always wins."
          >
            {(id) => (
              <SettingInput
                id={id}
                type="number"
                min={1}
                value={values.attendance_geofence_default_radius_m ?? ''}
                onChange={(value) => onChange('attendance_geofence_default_radius_m', value)}
                disabled={disabled}
              />
            )}
          </Field>
        </div>
      </SectionCard>
    </div>
  );
}

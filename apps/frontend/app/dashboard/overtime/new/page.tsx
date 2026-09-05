'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslations } from 'next-intl';
import { Save, Clock, AlertCircle } from 'lucide-react';
import { usePageHeader } from '@/hooks/usePageHeader';
import { usePermission } from '@/hooks/usePermission';
import PageActionRow from '@/components/common/PageActionRow';
import overtimeService from '@/services/overtimeService';
import holidayService from '@/services/holidayService';
import { toast } from '@/lib/toast';
import { useAuthStore } from '@/store/authStore';
import { useBrandingStore } from '@/store/brandingStore';
import { formatCurrency } from '@/utils/formatters';
import { computeOvertimePreview, parseThresholdMinutes, OtType } from '@/utils/overtimeCalc';

// `reasonRequired` mirrors the overtime_require_reason admin setting: when the
// admin turns it off the reason may be left blank, but any text typed still has
// to clear the same minimum length the backend expects.
function buildOvertimeSchema(t: ReturnType<typeof useTranslations>, reasonRequired: boolean) {
  return z.object({
    date: z.string().min(1, t('dateRequiredError')),
    startTime: z.string().min(1, t('startTimeRequiredError')),
    endTime: z.string().min(1, t('endTimeRequiredError')),
    reason: reasonRequired
      ? z.string().min(10, t('reasonMinLengthError'))
      : z
          .string()
          .optional()
          .refine(v => !v || v.trim().length === 0 || v.trim().length >= 10, t('reasonMinLengthError')),
  })
    // An overnight shift is legitimate — 22:00 to 02:00 is four hours — so the
    // end may precede the start. What is never meaningful is the two being
    // IDENTICAL: `buildOvertimeWindow` rolls the end forward a full day when
    // `end <= start`, so picking 09:00 twice submitted a 24-hour claim (about 19
    // payable hours after the day-boundary clamp), plus a food allowance, for a
    // shift nobody worked. Nothing rejected it.
    .refine(data => data.startTime !== data.endTime, {
      message: t('sameStartEndError'),
      path: ['endTime'],
    });
}

// How far the overtime day may be back- or forward-dated in the picker.
const OVERTIME_BACKDATE_DAYS = 90;
const OVERTIME_FORWARD_DAYS = 90;

type OvertimeFormData = z.infer<ReturnType<typeof buildOvertimeSchema>>;

export default function NewOvertimePage() {
  const t = useTranslations('newOvertimePage');
  const tc = useTranslations('common');
  const tOvertime = useTranslations('overtimePage');
  const tMyOvertime = useTranslations('myOvertimePage');
  const router = useRouter();
  const { user } = useAuthStore();
  const { can } = usePermission();
  const { branding } = useBrandingStore();
  const [submitting, setSubmitting] = useState(false);

  // The one heading for this route, rendered by TopHeader. This declaration
  // wins over TopHeader's static getPageInfo() entry for /dashboard/overtime/new.
  usePageHeader(t('title'), t('subtitle'));

  const officeStart = branding?.office_start_time || '08:30';
  const officeEnd = branding?.office_end_time || '17:30';
  const reasonRequired = branding?.overtime_require_reason !== false;

  const formatTimeRange = (start: string, end: string) => {
    const formatTimePart = (timeStr: string) => {
      const [h, m] = timeStr.split(':').map(Number);
      if (isNaN(h) || isNaN(m)) return timeStr;
      const ampm = h >= 12 ? t('pmToken') : t('amToken');
      const displayHour = h % 12 || 12;
      const displayMin = m === 0 ? '' : `:${m < 10 ? '0' + m : m}`;
      return `${displayHour}${displayMin} ${ampm}`;
    };
    return `${formatTimePart(start)} - ${formatTimePart(end)}`;
  };

  const {
    register,
    handleSubmit,
    formState: { errors },
    watch,
  } = useForm<OvertimeFormData>({
    resolver: async (values, context, options) =>
      zodResolver(buildOvertimeSchema(t, reasonRequired))(values, context, options),
  });

  const startTime = watch('startTime');
  const endTime = watch('endTime');
  const date = watch('date');

  // Builds the ISO start/end timestamps and duration for an overtime window.
  // A time an on/before the start (e.g. 17:00 -> 03:00) is treated as an
  // overnight shift crossing midnight, not an invalid range: the end date is
  // rolled forward a day so the payable duration matches the day-boundary
  // clamp the backend applies (attendance_day_end_time).
  const buildOvertimeWindow = (dateStr: string, startStr: string, endStr: string) => {
    const start = new Date(`${dateStr}T${startStr}`);
    let end = new Date(`${dateStr}T${endStr}`);
    let endDateStr = dateStr;

    if (end <= start) {
      end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
      endDateStr = end.toISOString().split('T')[0];
    }

    const hours = Math.round(((end.getTime() - start.getTime()) / (1000 * 60 * 60)) * 10) / 10;

    return {
      startIso: `${dateStr}T${startStr}:00Z`,
      endIso: `${endDateStr}T${endStr}:00Z`,
      hours,
    };
  };

  const calculateHours = () => {
    if (!startTime || !endTime || !date) return 0;
    return buildOvertimeWindow(date, startTime, endTime).hours;
  };

  const [holidays, setHolidays] = useState<any[]>([]);

  useEffect(() => {
    holidayService.getAll().then(res => {
      if (res?.success && Array.isArray(res.data)) {
        setHolidays(res.data);
      }
    }).catch(err => console.error('Failed to load holidays:', err));
  }, []);

  // Overtime is often logged after the shift is worked — the employee stays
  // late and files the request the next morning — so the picker opens a
  // backward window instead of pinning `min` to today. The bounds only keep
  // stray typed years (0002-01-01) out; the server still enforces the caps.
  const dateBounds = useMemo(() => {
    const iso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const min = new Date();
    min.setDate(min.getDate() - OVERTIME_BACKDATE_DAYS);
    const max = new Date();
    max.setDate(max.getDate() + OVERTIME_FORWARD_DAYS);
    return { min: iso(min), max: iso(max) };
  }, []);

  const isSunday = useMemo(() => {
    if (!date) return false;
    const d = new Date(date);
    return d.getDay() === 0;
  }, [date]);

  const isHoliday = useMemo(() => {
    if (!date) return false;
    return holidays.some(h => {
      const hDate = new Date(h.date).toISOString().split('T')[0];
      return hDate === date;
    });
  }, [date, holidays]);

  const estimatedHours = calculateHours();
  const isDoubleDay = (isSunday || isHoliday) && !!branding?.overtime_double_ot_enabled;

  // Full payable preview, computed with the SAME engine the backend uses, so
  // what the employee sees (clamped hours, tier split, food allowance, otType)
  // matches what gets persisted on submit.
  const preview = useMemo(() => {
    if (!startTime || !endTime || !date) return null;
    // Parse as UTC wall-clock so the engine (UTC-based, matching backend + storage)
    // reads exactly the entered hh:mm.
    const start = new Date(`${date}T${startTime}:00Z`);
    const end = new Date(`${date}T${endTime}:00Z`);
    return computeOvertimePreview(start, end, isDoubleDay, {
      regularRate: parseFloat(branding?.overtime_regular_rate || '1.5') || 1.5,
      lateRate: parseFloat(branding?.overtime_late_rate || '1.5') || 1.5,
      doubleRate: parseFloat(branding?.overtime_double_rate || '2.0') || 2.0,
      doubleOtEnabled: !!branding?.overtime_double_ot_enabled,
      lateThresholdMinutes: parseThresholdMinutes(branding?.overtime_late_threshold || '22:00', 1320),
      dayBoundaryMinutes: parseThresholdMinutes(branding?.attendance_day_end_time || '23:59', 1439),
      foodAllowanceEnabled: !!branding?.overtime_food_allowance_enabled,
      foodAllowanceThresholdMinutes: parseThresholdMinutes(
        branding?.overtime_food_allowance_threshold || branding?.overtime_late_threshold || '22:00',
        1320,
      ),
      foodAllowanceAmount: parseFloat(branding?.overtime_food_allowance_amount || '150') || 0,
      doubleFoodAllowanceAnyTime: !!branding?.overtime_double_food_allowance_any_time,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startTime, endTime, date, isDoubleDay, branding]);

  const otTypeLabels: Record<OtType, string> = {
    REGULAR: t('otTypeRegular'),
    LATE: t('otTypeLate'),
    DOUBLE: t('otTypeDouble'),
    DOUBLE_LATE: t('otTypeDoubleLate'),
  };

  const onSubmit = async (data: OvertimeFormData) => {
    try {
      setSubmitting(true);

      const { startIso, endIso, hours } = buildOvertimeWindow(data.date, data.startTime, data.endTime);
      if (hours <= 0) {
        toast.warning(t('endBeforeStartWarning'));
        return;
      }

      await overtimeService.create({
        date: data.date,
        startTime: startIso,
        endTime: endIso,
        hours,
        reason: data.reason?.trim() || '',
      });

      toast.success(t('registerSuccess'));
      router.push(user?.role === 'EMPLOYEE' ? '/dashboard/my-overtime' : '/dashboard/overtime');
    } catch (error: any) {
      console.error('Failed to create overtime:', error);
      let errorMessage = t('registerFailedFallback');

      if (error?.message) {
        errorMessage = error.message;
      } else if (error?.response?.data?.message) {
        errorMessage = error.response.data.message;
      } else if (typeof error === 'string') {
        errorMessage = error;
      }

      toast.error(errorMessage);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6" data-testid="ess-overtime-new">
      {/* Back + breadcrumb. The title/description live in the sticky TopHeader
          (declared via usePageHeader above). The parent crumb is gated on the
          same permission the destination enforces, mirroring the post-submit
          redirect below — an EMPLOYEE has no VIEW_ALL_OVERTIME, so their list is
          /dashboard/my-overtime. */}
      <PageActionRow
        onBack={() => router.back()}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Form */}
        <div className="lg:col-span-2">
          <form onSubmit={handleSubmit(onSubmit)} className="bg-surface-card rounded-[--radius-card] p-4 md:p-8 border border-surface-border space-y-6 shadow-sm">
            {/* Date */}
            <div>
              <label className="block text-sm font-semibold text-text-body mb-2">
                {t('overtimeDayLabel')} <span className="text-status-error">*</span>
              </label>
              <input
                data-testid="overtime-date"
                type="date"
                {...register('date')}
                min={dateBounds.min}
                max={dateBounds.max}
                className="w-full px-4 py-3 border-2 border-surface-border bg-surface-card text-text-body rounded-[--radius-input] focus:outline-none focus:ring-4 focus:ring-brand-primary/20 focus:border-brand-primary transition-all"
              />
              {errors.date && (
                <p data-testid="ot-error-date" className="text-status-error text-sm mt-1">{errors.date.message}</p>
              )}
            </div>

            {/* Time Range */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-semibold text-text-body mb-2">
                  {t('startTimeLabel')} <span className="text-status-error">*</span>
                </label>
                <input
                  data-testid="overtime-start"
                  type="time"
                  {...register('startTime')}
                  className="w-full px-4 py-3 border-2 border-surface-border bg-surface-card text-text-body rounded-[--radius-input] focus:outline-none focus:ring-4 focus:ring-brand-primary/20 focus:border-brand-primary transition-all"
                />
                {errors.startTime && (
                  <p data-testid="ot-error-start" className="text-status-error text-sm mt-1">{errors.startTime.message}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-semibold text-text-body mb-2">
                  {t('endTimeLabel')} <span className="text-status-error">*</span>
                </label>
                <input
                  data-testid="overtime-end"
                  type="time"
                  {...register('endTime')}
                  className="w-full px-4 py-3 border-2 border-surface-border bg-surface-card text-text-body rounded-[--radius-input] focus:outline-none focus:ring-4 focus:ring-brand-primary/20 focus:border-brand-primary transition-all"
                />
                {errors.endTime && (
                  <p data-testid="ot-error-end" className="text-status-error text-sm mt-1">{errors.endTime.message}</p>
                )}
              </div>
            </div>

            {/* Estimated Hours & Rate Preview */}
            {preview && preview.totalHours > 0 && (
              <div
                data-testid="ot-preview"
                data-total-hours={preview.totalHours}
                data-ot-type={preview.otType}
                data-food-allowance={preview.foodAllowance}
                data-clamped={!!preview.clampedByBoundary}
                className="bg-brand-primary-light/10 border border-brand-primary/20 rounded-[--radius-card] p-5 space-y-4"
              >
                <div className="flex items-center gap-2 text-brand-primary">
                  <Clock className="text-brand-primary animate-pulse" size={20} />
                  <h3 className="font-bold">{t('calcPreviewHeading')}</h3>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-3 gap-4 pt-1 text-sm">
                  <div>
                    <p className="text-text-muted">{t('payableHoursLabel')}</p>
                    <p className="font-bold text-text-heading text-lg mt-0.5">{t('estimatedDurationValue', { hours: preview.totalHours })}</p>
                  </div>
                  <div>
                    <p className="text-text-muted">{t('dayClassificationLabel')}</p>
                    <p
                      data-testid="ot-day-class"
                      data-day-class={isHoliday ? 'HOLIDAY' : isSunday ? 'SUNDAY' : 'WEEKDAY'}
                      className="font-bold text-text-heading text-lg mt-0.5"
                    >
                      {isSunday ? (
                        <span className="text-status-error">{t('daySunday')}</span>
                      ) : isHoliday ? (
                        <span className="text-status-error">{t('dayPublicHoliday')}</span>
                      ) : (
                        <span className="text-brand-primary">{t('dayWeekday')}</span>
                      )}
                    </p>
                  </div>
                  <div>
                    <p className="text-text-muted">{t('otTypeLabel')}</p>
                    <p className="font-bold text-lg mt-0.5">
                      <span className={isDoubleDay ? 'text-status-error' : 'text-brand-primary'}>
                        {otTypeLabels[preview.otType]}
                      </span>
                    </p>
                  </div>
                </div>

                {/* Per-tier hour breakdown with the rate each tier is paid at */}
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3 pt-2 border-t border-brand-primary/10">
                  {preview.regularHours > 0 && (
                    <div className="text-sm">
                      <p className="text-text-muted">{t('tierRegular')} · {t('rateRegularOt', { rate: branding?.overtime_regular_rate || '1.5' })}</p>
                      <p data-testid="ot-preview-tier" data-tier="regular" data-hours={preview.regularHours} className="font-semibold text-text-heading mt-0.5">{t('hoursShort', { hours: preview.regularHours })}</p>
                    </div>
                  )}
                  {preview.lateHours > 0 && (
                    <div className="text-sm">
                      <p className="text-text-muted">{t('tierLate')} · {t('rateLateOt', { rate: branding?.overtime_late_rate || '1.5' })}</p>
                      <p data-testid="ot-preview-tier" data-tier="late" data-hours={preview.lateHours} className="font-semibold text-text-heading mt-0.5">{t('hoursShort', { hours: preview.lateHours })}</p>
                    </div>
                  )}
                  {preview.doubleHours > 0 && (
                    <div className="text-sm">
                      <p className="text-text-muted">{t('tierDouble')} · {t('rateDoubleOt', { rate: branding?.overtime_double_rate || '2.0' })}</p>
                      <p data-testid="ot-preview-tier" data-tier="double" data-hours={preview.doubleHours} className="font-semibold text-text-heading mt-0.5">{t('hoursShort', { hours: preview.doubleHours })}</p>
                    </div>
                  )}
                  <div className="text-sm">
                    <p className="text-text-muted">{t('foodAllowanceLabel')}</p>
                    <p className={`font-semibold mt-0.5 ${preview.foodAllowance > 0 ? 'text-status-success' : 'text-text-muted'}`}>
                      {preview.foodAllowance > 0 ? formatCurrency(preview.foodAllowance) : '—'}
                    </p>
                  </div>
                </div>

                {/* Day-boundary clamp warning — payable hours were trimmed */}
                {preview.clampedByBoundary && estimatedHours > preview.totalHours && (
                  <div data-testid="ot-clamp-note" className="bg-status-warning-bg/40 border border-status-warning/20 rounded-[--radius-button] p-3 text-xs text-status-warning">
                    {t('clampedNote', {
                      time: branding?.attendance_day_end_time || '23:59',
                      dropped: Math.round((estimatedHours - preview.totalHours) * 10) / 10,
                    })}
                  </div>
                )}

                {isDoubleDay && (
                  <div data-testid="ot-double-note" className="bg-status-error-bg/30 border border-status-error/20 rounded-[--radius-button] p-3 text-xs text-status-error">
                    <strong>{t('noteLabel')}</strong> {t('noteDesc')}
                  </div>
                )}
              </div>
            )}

            {/* Reason */}
            <div>
              <label className="block text-sm font-semibold text-text-body mb-2">
                {t('reasonLabel')}{' '}
                {reasonRequired ? (
                  <span className="text-status-error">*</span>
                ) : (
                  <span className="text-text-muted font-normal">{t('reasonOptionalTag')}</span>
                )}
              </label>
              <textarea
                data-testid="ot-reason"
                {...register('reason')}
                rows={6}
                placeholder={t('reasonPlaceholder')}
                className="w-full px-4 py-3 border-2 border-surface-border bg-surface-card text-text-body rounded-[--radius-input] focus:outline-none focus:ring-4 focus:ring-brand-primary/20 focus:border-brand-primary transition-all resize-none"
              />
              {errors.reason && (
                <p data-testid="ot-error-reason" className="text-status-error text-sm mt-1">{errors.reason.message}</p>
              )}
            </div>

            {/* Actions */}
            <div className="flex gap-4 pt-6 border-t border-surface-border">
              <button
                data-testid="overtime-submit"
                type="submit"
                disabled={submitting}
                className="flex-1 flex items-center justify-center gap-2 px-6 py-3 bg-gradient-to-r from-brand-primary to-brand-primary-dark text-text-on-brand rounded-[--radius-button] font-semibold hover:shadow-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              >
                {submitting ? (
                  <>
                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                    {t('sendingBtn')}
                  </>
                ) : (
                  <>
                    <Save size={20} />
                    {t('submitBtn')}
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={() => router.back()}
                className="px-6 py-3 border-2 border-surface-border bg-surface-card text-text-body rounded-[--radius-button] hover:bg-surface-page transition-colors cursor-pointer"
              >
                {tc('cancel')}
              </button>
            </div>
          </form>
        </div>

        {/* Info */}
        <div className="space-y-4">
          {/* Guidelines */}
          <div className="bg-status-warning-bg/30 border border-status-warning/20 rounded-[--radius-card] p-6 text-status-warning shadow-sm">
            <div className="flex items-center gap-2 mb-4">
              <AlertCircle className="text-status-warning" size={20} />
              <h3 className="font-bold text-status-warning">{t('guidelinesHeading')}</h3>
            </div>
            <ul className="text-sm text-status-warning/90 space-y-2">
              <li>• {t('guidelineOfficeHours', { range: formatTimeRange(officeStart, branding?.overtime_shift_end_time || '17:00') })}</li>
              <li>• {t('guidelineMaxHours', { month: branding?.overtime_max_hours_per_month || '30', year: branding?.overtime_max_hours_per_year || '200' })}</li>
              <li>• {t('guidelineApprovalNeeded')}</li>
              <li>• {t('guidelineSalaryFormula', { percentage: parseFloat(branding?.overtime_regular_rate || '1.5') * 100 })}</li>
            </ul>
          </div>

          {/* Overtime Rates */}
          <div className="bg-surface-card rounded-[--radius-card] p-6 border border-surface-border shadow-sm">
            <h3 className="font-bold text-brand-primary mb-4">{t('ratesHeading')}</h3>
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-sm text-text-muted">{t('rateOrdinaryDay')}</span>
                <span className="font-bold text-brand-primary">{parseFloat(branding?.overtime_regular_rate || '1.5') * 100}%</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-text-muted">{t('rateWeekendSunday')}</span>
                <span className="font-bold text-brand-primary">
                  {branding?.overtime_double_ot_enabled
                    ? `${parseFloat(branding?.overtime_double_rate || '2.0') * 100}%`
                    : `${parseFloat(branding?.overtime_regular_rate || '1.5') * 100}%`}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-text-muted">{t('ratePublicHoliday')}</span>
                <span className="font-bold text-brand-primary">
                  {branding?.overtime_double_ot_enabled
                    ? `${parseFloat(branding?.overtime_double_rate || '2.0') * 100}%`
                    : `${parseFloat(branding?.overtime_regular_rate || '1.5') * 100}%`}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

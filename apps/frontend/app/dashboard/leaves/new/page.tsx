'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslations } from 'next-intl';
import { Calendar, Save } from 'lucide-react';
import { usePageHeader } from '@/hooks/usePageHeader';
import PageActionRow from '@/components/common/PageActionRow';
import leaveService from '@/services/leaveService';
import libraryService from '@/services/libraryService';
import { useAuthStore } from '@/store/authStore';
import { LeaveBalance } from '@/types/leave';
import { toast } from '@/lib/toast';

const leaveSchema = z.object({
  leaveType: z.string().min(1, 'Leave type is required'),
  startDate: z.string().min(1, 'Start date is required'),
  endDate: z.string().min(1, 'End date is required'),
  reason: z.string().min(10, 'The reason must be at least 10 characters'),
});

type LeaveFormData = z.infer<typeof leaveSchema>;

export default function NewLeavePage() {
  const t = useTranslations('newLeaveRequestPage');
  const tc = useTranslations('common');
  const router = useRouter();
  const { user } = useAuthStore();

  // The one heading for this route, rendered by TopHeader.
  usePageHeader(t('title'), t('subtitle'));

  const [balance, setBalance] = useState<LeaveBalance | null>(null);
  const [leaveTypes, setLeaveTypes] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);

  // HR/ADMIN should not create leave requests for themselves
  // They should only approve/reject requests from other employees
  const isHROrAdmin = user?.role && ['ADMIN', 'HR_MANAGER'].includes(user.role);

  const {
    register,
    handleSubmit,
    formState: { errors },
    watch,
    setValue,
  } = useForm<LeaveFormData>({
    resolver: zodResolver(leaveSchema),
    defaultValues: {
      leaveType: '',
    },
  });

  useEffect(() => {
    const fetchLeaveTypes = async () => {
      try {
        const res = await libraryService.getAll('LEAVE_TYPE', true);
        if (res.success && res.data.length > 0) {
          const employeeGender = (user?.employee?.gender || '').toUpperCase();
          const filtered = res.data.filter((t) => {
            if (!t.genderRestriction) return true;
            if (!employeeGender) return true; // gender not set → show all types
            return t.genderRestriction.toUpperCase() === employeeGender;
          });
          setLeaveTypes(filtered);
          if (filtered.length > 0) setValue('leaveType', filtered[0].label);
        }
      } catch (error) {
        console.error('Failed to fetch leave types:', error);
      }
    };
    fetchLeaveTypes();
  }, [setValue, user?.employee?.gender]);

  const startDate = watch('startDate');
  const endDate = watch('endDate');

  useEffect(() => {
    if (user?.employeeId && !isHROrAdmin) {
      fetchBalance();
    }
  }, [user?.id]); // Use user.id to wait for user to load

  const fetchBalance = async () => {
    if (!user?.employeeId) return;

    try {
      setLoading(true);
      const response = await leaveService.getBalance(user.employeeId);
      setBalance(response.data);
    } catch (error) {
      console.error('Failed to fetch balance:', error);
    } finally {
      setLoading(false);
    }
  };

  const calculateDays = () => {
    if (!startDate || !endDate) return 0;
    const start = new Date(startDate);
    const end = new Date(endDate);
    const diffTime = Math.abs(end.getTime() - start.getTime());
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;
    return diffDays;
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    const filesArray = Array.from(e.target.files);

    // Limit to PDF + images only, and max 10MB each
    const validFiles: File[] = [];
    const ALLOWED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg'];
    const MAX_SIZE = 10 * 1024 * 1024; // 10MB

    for (const file of filesArray) {
      if (!ALLOWED_TYPES.includes(file.type)) {
        toast.error(t('invalidFileType', { name: file.name }));
        continue;
      }
      if (file.size > MAX_SIZE) {
        toast.error(t('fileSizeExceeds', { name: file.name }));
        continue;
      }
      validFiles.push(file);
    }

    setAttachments(prev => [...prev, ...validFiles]);
  };

  const removeSelectedFile = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  const onSubmit = async (data: LeaveFormData) => {
    try {
      setSubmitting(true);
      const response = await leaveService.create(data);
      const leaveId = response.data.id;

      if (attachments.length > 0) {
        setUploading(true);
        for (const file of attachments) {
          await leaveService.uploadAttachment(leaveId, file);
        }
      }

      toast.success(t('submitSuccess'));
      router.push('/dashboard/my-leaves');
    } catch (error: any) {
      console.error('Failed to create leave request:', error);
      const errorMessage = error?.response?.data?.message || error?.message || t('submitFailed');
      toast.error(errorMessage);
    } finally {
      setSubmitting(false);
      setUploading(false);
    }
  };

  const estimatedDays = calculateDays();

  return (
    <>
      {isHROrAdmin ? (
        <div className="flex items-center justify-center min-h-[60vh]">
          <div className="text-center space-y-3">
            <h2 className="text-lg sm:text-xl font-semibold text-text-heading">{t('noAccessTitle')}</h2>
            <p className="text-sm text-text-muted">{t('noAccessDesc1')}</p>
            <p className="text-sm text-text-muted">{t('noAccessDesc2')}</p>
            <button
              onClick={() => router.push('/dashboard/leaves')}
              className="mt-4 inline-flex items-center justify-center h-12 md:h-10 px-4 bg-brand-primary text-text-on-brand text-sm font-medium rounded-[--radius-button] hover:bg-brand-primary-dark transition-colors touch-manipulation"
            >
              {t('backToListCapital')}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4 sm:space-y-5" data-testid="ess-leave-new">
          {/* Back + breadcrumb. The title/description live in the sticky
              TopHeader (declared via usePageHeader above). The parent crumb is
              gated on the same permission the destination enforces — this branch
              only renders for a non-HR/admin employee, who may still be a
              MANAGER with VIEW_ALL_LEAVES. */}
          <PageActionRow
            onBack={() => router.back()}
          />

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 sm:gap-4">
            {/* Form */}
            <div className="lg:col-span-2">
              <form onSubmit={handleSubmit(onSubmit)} className="bg-surface-card rounded-[--radius-card] p-4 sm:p-5 border border-surface-border shadow-sm space-y-4">
                {/* Leave Type */}
                <div>
                  {/* neutral — not brand-specific */}
                  <label className="block text-xs font-medium text-text-body mb-1">
                    {tc('leaveTypeLabel')} <span className="text-status-error">*</span>
                  </label>
                  <select
                    {...register('leaveType')}
                    className="w-full h-12 md:h-10 px-3 text-base md:text-sm border border-surface-border rounded-[--radius-input] focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary text-text-body bg-surface-card"
                  >
                    {leaveTypes.map((t) => (
                      <option key={t.id} value={t.label}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                  {errors.leaveType && (
                    <p className="text-status-error text-xs mt-1">{errors.leaveType.message}</p>
                  )}
                </div>

                {/* Date Range */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    {/* neutral — not brand-specific */}
                    <label className="block text-xs font-medium text-text-body mb-1">
                      {tc('startDate')} <span className="text-status-error">*</span>
                    </label>
                    <input
                      type="date"
                      {...register('startDate')}
                      min={new Date().toISOString().split('T')[0]}
                      className="w-full h-12 md:h-10 px-3 text-base md:text-sm border border-surface-border rounded-[--radius-input] focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary text-text-body bg-surface-card"
                    />
                    {errors.startDate && (
                      <p className="text-status-error text-xs mt-1">{errors.startDate.message}</p>
                    )}
                  </div>

                  <div>
                    {/* neutral — not brand-specific */}
                    <label className="block text-xs font-medium text-text-body mb-1">
                      {tc('endDate')} <span className="text-status-error">*</span>
                    </label>
                    <input
                      type="date"
                      {...register('endDate')}
                      min={startDate || new Date().toISOString().split('T')[0]}
                      className="w-full h-12 md:h-10 px-3 text-base md:text-sm border border-surface-border rounded-[--radius-input] focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary text-text-body bg-surface-card"
                    />
                    {errors.endDate && (
                      <p className="text-status-error text-xs mt-1">{errors.endDate.message}</p>
                    )}
                  </div>
                </div>

                {/* Estimated Days */}
                {estimatedDays > 0 && (
                  <div className="bg-brand-primary-light/10 border border-brand-primary/20 rounded-lg p-3">
                    <p className="text-xs sm:text-sm text-brand-primary font-medium">
                      <span className="font-semibold">{t('estimatedDaysLabel')}</span> {t('estimatedDaysValue', { days: estimatedDays })}
                      <span className="text-xs ms-2 text-text-muted">{t('weekendNote')}</span>
                    </p>
                  </div>
                )}

                {/* Reason */}
                <div>
                  {/* neutral — not brand-specific */}
                  <label className="block text-xs font-medium text-text-body mb-1">
                    {tc('reason')} <span className="text-status-error">*</span>
                  </label>
                  <textarea
                    {...register('reason')}
                    rows={4}
                    placeholder={t('reasonPlaceholder')}
                    className="w-full px-3 py-2.5 text-base md:text-sm border border-surface-border rounded-[--radius-input] focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary text-text-body bg-surface-card"
                  />
                  {errors.reason && (
                    <p className="text-status-error text-xs mt-1">{errors.reason.message}</p>
                  )}
                </div>

                {/* Attachments */}
                <div className="space-y-2">
                  {/* neutral — not brand-specific */}
                  <label className="block text-xs font-medium text-text-body mb-1">
                    {t('attachmentsLabel')} <span className="text-text-muted font-normal">{t('attachmentsHint')}</span>
                  </label>
                  <div className="flex items-center justify-center w-full">
                    <label className="flex flex-col items-center justify-center w-full p-4 border-2 border-surface-border border-dashed rounded-lg cursor-pointer bg-surface-page hover:bg-surface-page/70 transition-colors">
                      <div className="flex flex-col items-center justify-center">
                        <svg className="w-5 h-5 mb-1.5 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"></path></svg>
                        <p className="text-xs sm:text-sm text-text-body"><span className="font-semibold">{t('clickToUpload')}</span>{t('orDragDrop')}</p>
                        <p className="text-xs text-text-muted mt-0.5">{t('uploadHint')}</p>
                      </div>
                      <input
                        type="file"
                        multiple
                        className="hidden"
                        accept=".pdf,.jpg,.jpeg,.png"
                        onChange={handleFileChange}
                      />
                    </label>
                  </div>

                  {attachments.length > 0 && (
                    <div className="mt-3 space-y-2">
                      {/* neutral — not brand-specific */}
                      <p className="text-[11px] font-medium text-text-muted uppercase tracking-wide">{t('selectedFilesLabel')}</p>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        {attachments.map((file, idx) => (
                          <div key={idx} className="flex items-center justify-between p-2.5 bg-surface-page border border-surface-border rounded-lg text-sm text-text-body">
                            <span className="truncate max-w-[200px]">{file.name}</span>
                            <span className="text-xs text-text-muted ms-2">{t('fileSizeMbParen', { size: (file.size / (1024 * 1024)).toFixed(2) })}</span>
                            <button
                              type="button"
                              onClick={() => removeSelectedFile(idx)}
                              className="text-status-error hover:opacity-80 transition-colors p-1"
                            >
                              {t('removeBtn')}
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {uploading && (
                    <div className="flex items-center gap-2 text-sm text-brand-primary">
                      <div className="w-4 h-4 border-2 border-brand-primary border-t-transparent rounded-full animate-spin"></div>
                      {t('uploadingAttachments')}
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div className="flex gap-3 pt-4 border-t border-surface-border">
                  <button
                    data-testid="leave-submit"
                    type="submit"
                    disabled={submitting}
                    className="flex-1 inline-flex items-center justify-center gap-2 h-12 md:h-10 px-4 bg-brand-primary text-text-on-brand rounded-[--radius-button] text-sm font-medium hover:bg-brand-primary-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed touch-manipulation active:scale-[0.99]"
                  >
                    {submitting ? (
                      <>
                        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                        {tc('sending')}
                      </>
                    ) : (
                      <>
                        <Save size={18} />
                        {t('submitRequestBtn')}
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => router.back()}
                    className="inline-flex items-center justify-center h-12 md:h-10 px-4 border border-surface-border text-sm font-medium text-text-body rounded-[--radius-button] hover:bg-surface-page transition-colors bg-surface-card touch-manipulation"
                  >
                    {tc('cancel')}
                  </button>
                </div>
              </form>
            </div>

            {/* Balance Info */}
            <div className="space-y-3 sm:space-y-4">
              {loading ? (
                <div className="animate-pulse space-y-3">
                  <div className="h-24 bg-surface-page rounded-xl"></div>
                  <div className="h-24 bg-surface-page rounded-xl"></div>
                </div>
              ) : balance && balance.leaveTypeBalances && balance.leaveTypeBalances.length > 0 ? (
                balance.leaveTypeBalances.map((tb, idx) => (
                  <div
                    key={tb.id || idx}
                    className={`bg-surface-card rounded-xl p-4 border ${
                      tb.leaveTypeKey.toLowerCase().includes('annual')
                        ? 'border-brand-primary ring-1 ring-brand-primary/30'
                        : 'border-surface-border'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 mb-2">
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                        tb.leaveTypeKey.toLowerCase().includes('annual') ? 'bg-brand-primary/10' : 'bg-surface-page'
                      }`}>
                        <Calendar className={tb.leaveTypeKey.toLowerCase().includes('annual') ? 'text-brand-primary' : 'text-text-muted'} size={16} />
                      </div>
                      <p className="text-xs font-medium text-text-muted truncate">
                        {t('remainingTypeLabel', { type: tb.leaveTypeKey })}
                      </p>
                    </div>
                    <p className="text-xl sm:text-2xl font-semibold tabular-nums text-text-heading">
                      <span className="text-xs font-normal text-text-muted ms-1">
                        {t('remainingOfDays', { remaining: tb.remaining, total: tb.allocated + tb.carriedOver })}
                      </span>
                    </p>
                  </div>
                ))
              ) : (
                <>
                  {/* Annual Leave Balance (Fallback) */}
                  <div className="bg-surface-card rounded-xl p-4 border border-brand-primary ring-1 ring-brand-primary/30">
                    <div className="flex items-center gap-2.5 mb-2">
                      <div className="w-8 h-8 bg-brand-primary/10 rounded-lg flex items-center justify-center">
                        <Calendar className="text-brand-primary" size={16} />
                      </div>
                      <p className="text-xs font-medium text-text-muted truncate">{t('remainingAnnualLeave')}</p>
                    </div>
                    <p className="text-xl sm:text-2xl font-semibold tabular-nums text-text-heading">
                      <span className="text-xs font-normal text-text-muted ms-1">
                        {t('remainingOfDays', {
                          remaining: balance ? (balance.remainingAnnual ?? (balance.annualLeave + balance.carriedOver - balance.usedAnnual)) : 0,
                          total: balance ? (balance.annualLeave + balance.carriedOver) : 0,
                        })}
                      </span>
                    </p>
                  </div>

                  {/* Sick Leave Balance (Fallback) */}
                  <div className="bg-surface-card rounded-xl p-4 border border-surface-border">
                    <div className="flex items-center gap-2.5 mb-2">
                      <div className="w-8 h-8 bg-status-success-bg rounded-lg flex items-center justify-center">
                        <Calendar className="text-status-success" size={16} />
                      </div>
                      <p className="text-xs font-medium text-text-muted truncate">{t('remainingSickLeave')}</p>
                    </div>
                    <p className="text-xl sm:text-2xl font-semibold tabular-nums text-text-heading">
                      <span className="text-xs font-normal text-text-muted ms-1">
                        {t('remainingOfDays', {
                          remaining: balance ? (balance.remainingSick ?? (balance.sickLeave - balance.usedSick)) : 0,
                          total: balance?.sickLeave || 0,
                        })}
                      </span>
                    </p>
                  </div>
                </>
              )}

              {/* Note */}
              <div className="bg-status-warning-bg border border-status-warning/30 rounded-lg p-3">
                <p className="text-xs sm:text-sm text-status-warning font-medium mb-1.5">{t('noteLabel')}</p>
                <ul className="text-xs text-status-warning space-y-1">
                  <li>• {t('noteAnnual3Days')}</li>
                  <li>• {t('noteSickMedical')}</li>
                  <li>• {t('noteWeekendsExcluded')}</li>
                  <li>• {t('noteRoutedManager')}</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

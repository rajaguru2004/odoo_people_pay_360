'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/authStore';
import { FaceRegistration } from '@/components/face-recognition';
import faceRecognitionService from '@/services/faceRecognitionService';
import { usePageHeader } from '@/hooks/usePageHeader';
import { ArrowLeftIcon } from '@/components/common/icons/directional';

export default function FaceRecognitionPage() {
  const t = useTranslations('faceRecognitionPage');
  const router = useRouter();
  const { user } = useAuthStore();

  // The one heading for this route, rendered by TopHeader.
  usePageHeader(t('title'), t('subtitle'));

  const [status, setStatus] = useState<{
    isRegistered: boolean;
    totalRegistered: number;
    maxAllowed: number;
  } | null>(null);

  const loadStatus = async () => {
    try {
      const response = await faceRecognitionService.getRegistrationStatus();
      // Axios interceptor unwraps response.data → { success, data: { isRegistered, ... } }
      const data = (response as any)?.data ?? response;
      if (data && typeof data.isRegistered !== 'undefined') {
        setStatus(data);
      }
    } catch (error) {
      console.error('Failed to load status:', error);
    }
  };

  useEffect(() => {
    loadStatus();
  }, []);

  return (
    <>
    <div className="p-0 md:p-4 md:p-6" data-testid="ess-face-recognition">
      {/* Back navigation */}
      <button
        onClick={() => router.push('/dashboard/my-attendance')}
        className="mb-4 flex items-center gap-2 text-sm text-text-body hover:text-text-heading"
      >
        <ArrowLeftIcon className="h-4 w-4" />
        {t('backToAttendance')}
      </button>

      {/* Status card */}
      {status && (
        <div className="mb-4 rounded-xl bg-surface-card p-4 sm:p-5 border border-surface-border shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <h3 className="text-sm font-semibold text-text-heading">Status</h3>
              <span
                className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${
                  status.isRegistered
                    ? 'bg-status-success-bg text-status-success'
                    : 'bg-status-warning-bg text-status-warning'
                }`}
              >
                {status.isRegistered
                  ? t('registeredPhotos', { count: status.totalRegistered })
                  : t('notRegisteredYet')}
              </span>
            </div>

            {status.isRegistered && (
              <button
                onClick={() => router.push('/dashboard/my-attendance')}
                className="inline-flex h-11 md:h-9 items-center justify-center gap-2 rounded-lg px-4 md:px-3 text-sm font-medium border border-surface-border text-text-body transition-colors hover:bg-surface-page touch-manipulation"
              >
                {t('goToFaceAttendance')}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Face registration component */}
      <div className="rounded-xl bg-surface-card p-4 sm:p-5 border border-surface-border shadow-sm">
        <FaceRegistration onRegistrationComplete={loadStatus} />
      </div>

      {/* Info section */}
      <div className="mt-4 sm:mt-5 rounded-xl bg-surface-card p-4 sm:p-5 border border-surface-border shadow-sm">
        <h3 className="mb-3 text-sm sm:text-base font-semibold text-text-heading">
          {t('userGuide')}
        </h3>
        <div className="grid gap-3 sm:gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-surface-border-light bg-surface-page p-3">
            <h4 className="mb-1 text-sm font-medium text-text-heading">
              {t('step1Title')}
            </h4>
            <p className="text-xs text-text-muted">
              {t('step1Desc')}
            </p>
          </div>
          <div className="rounded-lg border border-surface-border-light bg-surface-page p-3">
            <h4 className="mb-1 text-sm font-medium text-text-heading">
              {t('step2Title')}
            </h4>
            <p className="text-xs text-text-muted">
              {t('step2Desc')}
            </p>
          </div>
          <div className="rounded-lg border border-surface-border-light bg-surface-page p-3">
            <h4 className="mb-1 text-sm font-medium text-text-heading">
              {t('step3Title')}
            </h4>
            <p className="text-xs text-text-muted">
              {t('step3Desc')}
            </p>
          </div>
          <div className="rounded-lg border border-surface-border-light bg-surface-page p-3">
            <h4 className="mb-1 text-sm font-medium text-text-heading">
              {t('step4Title')}
            </h4>
            <p className="text-xs text-text-muted">
              {t('step4Desc')}
            </p>
          </div>
        </div>
      </div>
    </div>
    </>
  );
}

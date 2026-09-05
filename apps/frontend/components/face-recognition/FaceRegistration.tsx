'use client';

import { useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  Focus,
  ImagePlus,
  Shield,
  Trash2,
  Upload,
  UserCheck,
} from 'lucide-react';
import WebcamCapture from './WebcamCapture';
import { toJpegDataUrl } from './toJpegDataUrl';
import {
  useDeleteFaceEnrollment,
  useEmployeeFaceEnrollments,
  useMyFaceEnrollments,
  useRegisterFace,
} from '@/hooks/useFaceEnrollments';
import { apiErrorMessage } from '@/utils/apiError';
import { formatDate } from '@/utils/formatDate';
import { resolveFileUrl } from '@/utils/fileUrl';
import type { FaceEnrollmentGalleryItem } from '@/types/attendance';

interface FaceRegistrationProps {
  /** Enrol somebody else. HR only; omitted, the component enrols the caller. */
  employeeId?: string;
  employeeName?: string;
  onRegistrationComplete?: () => void;
}

/** What matching needs before a punch can rely on it. */
const REQUIRED = 3;

/**
 * The three angles, in order.
 *
 * A template built from a turned head matches a turned head and little else, so
 * one frontal capture recognises a person only when they stand exactly as they
 * did at enrolment. Three poses is the smallest set that survives somebody
 * glancing at the terminal rather than staring into it.
 */
const STEPS = [
  {
    label: 'Step 1 of 3 — straight on',
    hint: 'Look directly at the camera with your head level.',
    icon: Focus,
  },
  {
    label: 'Step 2 of 3 — turn slightly left',
    hint: 'About 15–20°. A small turn, not a profile.',
    icon: ChevronLeft,
  },
  {
    label: 'Step 3 of 3 — turn slightly right',
    hint: 'About 15–20° the other way.',
    icon: ChevronRight,
  },
];

export default function FaceRegistration({
  employeeId,
  employeeName,
  onRegistrationComplete,
}: FaceRegistrationProps) {
  const [mode, setMode] = useState<'list' | 'webcam'>('list');
  const [message, setMessage] = useState<
    { type: 'success' | 'error'; text: string } | null
  >(null);

  // Whose gallery. An employee reads their own through `/me`, which can only
  // ever answer about the caller; HR reads a named one through the HR route.
  const mineQuery = useMyFaceEnrollments();
  const theirsQuery = useEmployeeFaceEnrollments(employeeId);
  const query = employeeId ? theirsQuery : mineQuery;

  const register = useRegisterFace();
  const remove = useDeleteFaceEnrollment();

  const enrolments = useMemo<FaceEnrollmentGalleryItem[]>(
    () => (query.data?.data as FaceEnrollmentGalleryItem[] | undefined) ?? [],
    [query.data],
  );
  const total = enrolments.length;
  // The cap the server enforces, learnt from the last successful capture. Until
  // one lands the list itself is the only honest bound to draw.
  const [maxAllowed, setMaxAllowed] = useState(5);

  const handleCapture = async (image: string) => {
    setMessage(null);
    try {
      const response = await register.mutateAsync({
        image,
        ...(employeeId ? { employeeId } : {}),
      });
      const result = response.data;
      setMaxAllowed(result.maxAllowed);
      setMessage({
        type: 'success',
        text: `Capture ${result.totalRegistered} of ${REQUIRED} saved at ${Math.round(
          result.quality * 100,
        )}% quality.`,
      });

      if (result.totalRegistered >= REQUIRED) {
        onRegistrationComplete?.();
        setMode('list');
      }
      // Otherwise stay on the camera: the next step appears by itself.
    } catch (error) {
      setMessage({
        type: 'error',
        text: apiErrorMessage(error, 'That capture could not be enrolled'),
      });
    }
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Cleared before the await, so choosing the same file twice fires `change`
    // the second time too.
    event.target.value = '';
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      setMessage({ type: 'error', text: 'Choose an image file.' });
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setMessage({ type: 'error', text: 'That photo is over 10 MB. Choose a smaller one.' });
      return;
    }

    try {
      // Re-encoded rather than sent as chosen — see `toJpegDataUrl`.
      await handleCapture(await toJpegDataUrl(file));
    } catch (error) {
      setMessage({
        type: 'error',
        text: (error as Error).message || 'That file could not be read as an image.',
      });
    }
  };

  const handleDelete = async (id: string) => {
    setMessage(null);
    try {
      await remove.mutateAsync(id);
      setMessage({ type: 'success', text: 'That capture was deleted.' });
    } catch (error) {
      setMessage({
        type: 'error',
        text: apiErrorMessage(error, 'That capture could not be deleted'),
      });
    }
  };

  if (query.isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-primary border-t-transparent" />
      </div>
    );
  }

  const step = total < REQUIRED ? STEPS[total] : null;
  const StepIcon = step?.icon;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-primary/10">
            <Shield className="h-4 w-4 text-brand-primary" aria-hidden />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-text-heading sm:text-base">
              Face registration
              {employeeName && <span className="text-brand-primary"> — {employeeName}</span>}
            </h3>
            <p className="text-xs text-text-muted">
              {total} of {REQUIRED} required captures on file
              {total >= REQUIRED && maxAllowed > REQUIRED && ` (up to ${maxAllowed})`}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {Array.from({ length: REQUIRED }, (_, i) => (
            <div
              key={i}
              className={`h-2.5 w-2.5 rounded-full ${
                i < total ? 'bg-status-success' : 'bg-surface-border'
              }`}
            />
          ))}
        </div>
      </div>

      {message && (
        <div
          data-testid="facereg-message"
          data-kind={message.type}
          role="status"
          className={`flex items-start gap-2.5 rounded-lg border p-3 ${
            message.type === 'success'
              ? 'border-status-success/20 bg-status-success-bg/40 text-status-success'
              : 'border-status-error/20 bg-status-error-bg/40 text-status-error'
          }`}
        >
          {message.type === 'success' ? (
            <CheckCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          ) : (
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          )}
          <p className="text-xs sm:text-sm">{message.text}</p>
        </div>
      )}

      {total < REQUIRED && (
        <div className="rounded-lg border border-brand-primary/15 bg-brand-primary/5 p-3">
          <p className="text-xs font-medium text-text-heading">Before you start</p>
          <ul className="mt-1.5 list-inside list-disc space-y-1 text-xs text-text-muted">
            <li>Three captures, from three slightly different angles.</li>
            <li>Even light on the face, not bright light behind it.</li>
            <li>Nothing across the face — no mask, no dark glasses.</li>
          </ul>
        </div>
      )}

      {mode === 'list' ? (
        <div>
          <span
            data-testid="facereg-panel"
            data-count={total}
            data-max={maxAllowed}
            className="sr-only"
          />

          {enrolments.length > 0 && (
            <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 md:grid-cols-5">
              {enrolments.map((item) => (
                <div
                  key={item.id}
                  data-testid={`facereg-item-${item.id}`}
                  data-quality={item.quality}
                  className="group relative overflow-hidden rounded-[var(--radius-card)] border border-surface-border bg-surface-card"
                >
                  {resolveFileUrl(item.imageUrl) ? (
                    <img
                      src={resolveFileUrl(item.imageUrl)!}
                      alt="A capture on file"
                      className="aspect-square w-full object-cover"
                    />
                  ) : (
                    <div className="flex aspect-square items-center justify-center bg-surface-page">
                      <UserCheck className="h-8 w-8 text-text-muted" aria-hidden />
                    </div>
                  )}
                  <div className="p-2">
                    <p className="text-xs text-text-muted">
                      Quality {Math.round(item.quality * 100)}%
                    </p>
                    <p className="text-xs text-text-muted opacity-80">
                      {formatDate(item.createdAt)}
                    </p>
                  </div>
                  <button
                    type="button"
                    data-testid={`facereg-delete-${item.id}`}
                    onClick={() => void handleDelete(item.id)}
                    disabled={remove.isPending}
                    aria-label="Delete this capture"
                    className="absolute end-1 top-1 rounded-full bg-status-error/80 p-1.5 text-text-on-brand opacity-0 transition-opacity hover:bg-status-error focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <Trash2 className="h-3 w-3" aria-hidden />
                  </button>
                </div>
              ))}
            </div>
          )}

          {total < maxAllowed ? (
            <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
              <button
                type="button"
                onClick={() => {
                  setMessage(null);
                  setMode('webcam');
                }}
                className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-brand-primary px-4 text-sm font-medium text-text-on-brand transition-colors hover:bg-brand-primary-dark sm:w-auto"
              >
                <ImagePlus className="h-4 w-4" aria-hidden />
                {total < REQUIRED
                  ? `Start registration (step ${total + 1} of ${REQUIRED})`
                  : 'Add another capture'}
              </button>

              <label className="inline-flex h-9 w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-surface-border px-3 text-sm font-medium text-text-body transition-colors hover:bg-surface-page sm:w-auto">
                <Upload className="h-4 w-4" aria-hidden />
                Upload a photo
                <input
                  type="file"
                  accept="image/*"
                  onChange={(event) => void handleFileUpload(event)}
                  className="hidden"
                />
              </label>
            </div>
          ) : (
            <p data-testid="facereg-limit" className="text-xs text-status-warning">
              That is the limit of {maxAllowed} captures. Delete one before adding another.
            </p>
          )}
        </div>
      ) : (
        <div>
          <div className="mb-3 flex items-center justify-between">
            <h4 className="text-sm font-medium text-text-body">
              Capture {Math.min(total + 1, REQUIRED)} of {REQUIRED}
            </h4>
            <button
              type="button"
              onClick={() => setMode('list')}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-surface-border px-3 text-sm font-medium text-text-body transition-colors hover:bg-surface-page"
            >
              <ChevronLeft className="h-4 w-4 rtl:rotate-180" aria-hidden />
              Back
            </button>
          </div>

          {step && StepIcon && (
            <div className="mb-3 flex items-center gap-2.5 rounded-lg border border-brand-primary/20 bg-brand-primary/5 p-3 text-brand-primary">
              <StepIcon className="h-5 w-5 shrink-0" aria-hidden />
              <div>
                <p className="text-xs font-medium sm:text-sm">{step.label}</p>
                <p className="text-xs opacity-80">{step.hint}</p>
              </div>
              <div className="ms-auto flex gap-1.5">
                {STEPS.map((_, i) => (
                  <div
                    key={i}
                    className={`h-2.5 w-2.5 rounded-full ${
                      i < total
                        ? 'bg-status-success'
                        : i === total
                          ? 'bg-brand-primary'
                          : 'bg-surface-border'
                    }`}
                  />
                ))}
              </div>
            </div>
          )}

          <WebcamCapture
            // Remounted per step, which clears the previous frame's preview so
            // the next angle is taken against a live camera, not a still.
            key={total}
            onCapture={(image) => void handleCapture(image)}
            isProcessing={register.isPending}
            buttonText={step ? 'Capture this angle' : 'Capture'}
            width={480}
            height={360}
          />
        </div>
      )}
    </div>
  );
}

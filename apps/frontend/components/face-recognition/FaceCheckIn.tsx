'use client';

import { useState, useCallback, useEffect } from 'react';
import { getCompanyTz } from '@/utils/formatters';
import {
  LogIn,
  LogOut,
  CheckCircle,
  XCircle,
  User,
  Clock,
  Shield,
  Zap,
  RefreshCw,
} from 'lucide-react';
import WebcamCapture from './WebcamCapture';
import faceRecognitionService from '@/services/faceRecognitionService';
import { useAuthStore } from '@/store/authStore';
import { getCurrentCoords } from '@/lib/geolocation';
import { apiErrorMessage, apiErrorStatus } from '@/utils/apiError';

interface FaceCheckInProps {
  mode: 'check-in' | 'check-out' | 'lunch-check-in' | 'lunch-check-out';
  onSuccess?: (result: any) => void;
  onClose?: () => void;
  recognitionEnabled?: boolean;
  geofencingEnabled?: boolean;
}

export default function FaceCheckIn({
  mode,
  onSuccess,
  onClose,
  recognitionEnabled = true,
  geofencingEnabled = false,
}: FaceCheckInProps) {
  const { user } = useAuthStore();
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    employee: any;
    attendance: any;
    recognition: any;
    message: string;
  } | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);

  // Start countdown once result arrives
  useEffect(() => {
    if (result && countdown === null) {
      setCountdown(4);
    }
  }, [result]);

  // Tick countdown → auto-close at 0
  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      onClose?.();
      return;
    }
    const t = setTimeout(() => setCountdown((c) => (c !== null ? c - 1 : null)), 1000);
    return () => clearTimeout(t);
  }, [countdown, onClose]);

  const handleCapture = useCallback(
    async (imageBase64: string) => {
      try {
        setProcessing(true);
        setError(null);

        let coords: { latitude?: number; longitude?: number; accuracy?: number } | undefined;
        if (mode === 'check-in' && geofencingEnabled) {
          try {
            coords = await getCurrentCoords();
          } catch (geoErr: any) {
            setError(geoErr?.message || 'Could not determine your location.');
            return;
          }
        }

        let response: any;
        try {
          response = recognitionEnabled
            ? (mode === 'check-in'
              ? await faceRecognitionService.faceCheckIn(imageBase64, coords)
              : mode === 'check-out'
              ? await faceRecognitionService.faceCheckOut(imageBase64)
              : mode === 'lunch-check-in'
              ? await faceRecognitionService.faceLunchCheckIn(imageBase64)
              : await faceRecognitionService.faceLunchCheckOut(imageBase64))
            : (mode === 'check-in'
              ? await faceRecognitionService.captureCheckIn(imageBase64, coords)
              : mode === 'check-out'
              ? await faceRecognitionService.captureCheckOut(imageBase64)
              : mode === 'lunch-check-in'
              ? await faceRecognitionService.captureLunchCheckIn(imageBase64)
              : await faceRecognitionService.captureLunchCheckOut(imageBase64));
        } catch (apiErr: any) {
          // The geofencingEnabled prop can be stale (branding is fetched once at
          // app mount). If the server says location is required but we sent
          // none, request it now and retry once instead of a confusing error.
          // Read through apiErrorStatus/apiErrorMessage: `lib/axios.ts` rejects
          // with a FLAT object, so `apiErr.response.status` and
          // `apiErr.response.data.message` were BOTH undefined and this branch
          // could never be true — the retry-with-coordinates path was dead, and
          // a user on a geofenced branch got the raw server sentence instead of
          // a location prompt.
          const needsLocation =
            mode === 'check-in' &&
            coords === undefined &&
            apiErrorStatus(apiErr) === 400 &&
            /location access is required/i.test(apiErrorMessage(apiErr, ''));
          if (!needsLocation) throw apiErr;
          const retryCoords = await getCurrentCoords();
          response = recognitionEnabled
            ? await faceRecognitionService.faceCheckIn(imageBase64, retryCoords)
            : await faceRecognitionService.captureCheckIn(imageBase64, retryCoords);
        }

        // Axios interceptor unwraps one level → { success, message, data }
        const outer = response as any;
        const data = outer?.data ?? outer;
        const currentEmployeeId = user?.employeeId || user?.employee?.id;

        // Safety guard: if API returns another employee, do not proceed.
        if (
          recognitionEnabled &&
          currentEmployeeId &&
          data?.employee?.id &&
          data.employee.id !== currentEmployeeId
        ) {
          setError('The face does not match the login account. Please check your face data again.');
          return;
        }

        setResult({
          employee: data?.employee || (user?.employee ? {
            id: user.employee.id,
            fullName: user.employee.fullName,
            employeeCode: user.employee.employeeCode,
            avatarUrl: user.employee.avatarUrl || null,
          } : null),
          attendance: data?.attendance,
          recognition: data?.recognition,
          message:
            outer?.message ||
            (mode === 'check-in'
              ? 'Count on success!'
              : mode === 'lunch-check-in'
              ? 'Lunch check-in success!'
              : mode === 'lunch-check-out'
              ? 'Lunch check-out success!'
              : 'Score success!'),
        });

        onSuccess?.(data);
      } catch (err: any) {
        setError(apiErrorMessage(err, 'Identify failure. Please try again.'));
      } finally {
        setProcessing(false);
      }
    },
    [mode, onSuccess, user, recognitionEnabled, geofencingEnabled],
  );

  const isCheckIn = mode === 'check-in' || mode === 'lunch-check-in';

  // ── SUCCESS SCREEN ──────────────────────────────────────────────────────────
  if (result) {
    return (
      <div className="flex flex-col items-center gap-5 py-4">
        {/* Big check icon */}
        <div
          className={`flex h-24 w-24 items-center justify-center rounded-full ${
            isCheckIn ? 'bg-status-success-bg/40' : 'bg-brand-primary-light/20'
          }`}
        >
          <CheckCircle
            className={`h-14 w-14 ${isCheckIn ? 'text-status-success' : 'text-brand-primary'}`}
          />
        </div>

        <div className="text-center">
          <h3
            className={`text-2xl font-bold ${isCheckIn ? 'text-status-success' : 'text-brand-primary'}`}
          >
            {isCheckIn ? 'Count on success!' : 'Score success!'}
          </h3>
          <div className="mt-1.5 flex justify-center gap-2">
            {result.attendance?.isLate && (
              <span className="inline-block rounded-full bg-status-warning-bg/40 px-3 py-0.5 text-sm text-status-warning">
                ⚠ Being late
              </span>
            )}
            {result.attendance?.isEarlyLeave && (
              <span className="inline-block rounded-full bg-status-warning-bg/40 px-3 py-0.5 text-sm text-status-warning">
                ⚠ Leave early
              </span>
            )}
          </div>
        </div>

        {/* Employee card */}
        {result.employee && (
          <div
            className={`w-full max-w-sm rounded-[--radius-card] border-2 p-5 ${
              isCheckIn
                ? 'border-status-success/20 bg-status-success-bg/40'
                : 'border-brand-primary/20 bg-brand-primary-light/10'
            }`}
          >
            <div className="mb-3 flex items-center gap-3">
              {result.employee.avatarUrl ? (
                <img
                  src={result.employee.avatarUrl}
                  alt=""
                  className="h-12 w-12 rounded-full object-cover"
                />
              ) : (
                <div
                  className={`flex h-12 w-12 items-center justify-center rounded-full ${
                    isCheckIn ? 'bg-status-success-bg/40' : 'bg-brand-primary-light/20'
                  }`}
                >
                  <User
                    className={`h-6 w-6 ${isCheckIn ? 'text-status-success' : 'text-brand-primary'}`}
                  />
                </div>
              )}
              <div>
                <p
                  className={`text-lg font-bold ${
                    isCheckIn ? 'text-status-success' : 'text-brand-primary'
                  }`}
                >
                  {result.employee.fullName}
                </p>
                <p className={`text-sm ${isCheckIn ? 'text-status-success' : 'text-brand-primary'}`}>
                  {result.employee.employeeCode}
                </p>
              </div>
            </div>

            <div
              className={`flex items-center gap-2 text-sm font-medium ${
                isCheckIn ? 'text-status-success' : 'text-brand-primary'
              }`}
            >
              <Clock className="h-4 w-4 shrink-0" />
              <span>
                {mode === 'check-in'
                  ? `Entry time: ${result.attendance?.checkInTime ?? new Date().toLocaleTimeString('en-IN', { timeZone: getCompanyTz() })}`
                  : mode === 'check-out'
                  ? `Output time: ${result.attendance?.checkOutTime ?? new Date().toLocaleTimeString('en-IN', { timeZone: getCompanyTz() })}`
                  : mode === 'lunch-check-out'
                  ? `Lunch start time: ${new Date().toLocaleTimeString('en-IN', { timeZone: getCompanyTz() })}`
                  : `Lunch check-in time: ${new Date().toLocaleTimeString('en-IN', { timeZone: getCompanyTz() })}`}
              </span>
            </div>

            {!isCheckIn && result.attendance?.workHours != null && (
              <div
                className={`mt-1.5 flex items-center gap-2 text-sm ${
                  isCheckIn ? 'text-status-success' : 'text-brand-primary'
                }`}
              >
                <Zap className="h-4 w-4 shrink-0" />
                <span>Total working hours: {result.attendance.workHours}h</span>
              </div>
            )}
          </div>
        )}

        {/* Recognition stats */}
        {result.recognition && (
          <div className="flex gap-5 text-sm text-text-muted">
            <div className="flex items-center gap-1">
              <Shield className="h-4 w-4" />
              <span>
                Trust: <strong className="text-text-heading">{result.recognition.confidence}%</strong>
              </span>
            </div>
            <div className="flex items-center gap-1">
              <Zap className="h-4 w-4" />
              <span>
                Quality: <strong className="text-text-heading">{result.recognition.quality}%</strong>
              </span>
            </div>
          </div>
        )}

        {/* Countdown close button */}
        <button
          data-testid="face-capture-done"
          onClick={onClose}
          className={`mt-1 flex items-center gap-2 rounded-[--radius-button] px-8 py-3 font-semibold text-text-on-brand transition-all ${
            isCheckIn ? 'bg-status-success hover:bg-status-success/90' : 'bg-brand-primary hover:bg-brand-primary-dark'
          }`}
        >
          Completed
          {countdown !== null && countdown > 0 && (
            <span className="rounded-full bg-white/30 px-2 py-0.5 text-xs">{countdown}s</span>
          )}
        </button>
      </div>
    );
  }

  // ── CAMERA SCREEN ────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`rounded-[--radius-card] p-2.5 ${isCheckIn ? 'bg-status-success-bg/40' : 'bg-brand-primary-light/20'}`}>
            {isCheckIn ? (
              <LogIn className="h-6 w-6 text-status-success" />
            ) : (
              <LogOut className="h-6 w-6 text-brand-primary" />
            )}
          </div>
          <div>
            <h3 className="text-lg font-bold text-text-heading">
              {mode === 'check-in'
                ? 'Check in'
                : mode === 'check-out'
                ? 'Take time out'
                : mode === 'lunch-check-out'
                ? 'Start Lunch Break'
                : 'Back from Lunch'}
            </h3>
            <p className="text-sm text-text-muted">Look straight at the camera and then press shutter</p>
          </div>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="rounded-[--radius-button] p-2 text-text-muted hover:bg-surface-page hover:text-text-body"
          >
            <XCircle className="h-5 w-5" />
          </button>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-start gap-3 rounded-[--radius-card] border border-status-error/30 bg-status-error-bg/40 p-4">
          <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-status-error" />
          <div className="flex-1">
            <p className="font-medium text-status-error">Unable to clock time</p>
            <p className="mt-0.5 text-sm text-status-error">{error}</p>
          </div>
          <button
            onClick={() => setError(null)}
            className="shrink-0 rounded-[--radius-button] bg-status-error/20 px-3 py-1.5 text-xs font-semibold text-status-error hover:bg-status-error/30"
          >
            <RefreshCw className="mr-1 inline h-3 w-3" />
            Retry
          </button>
        </div>
      )}

      {/* Tip */}
      {!error && (
        <div
          className={`rounded-[--radius-card] px-4 py-3 text-sm ${
            isCheckIn ? 'bg-status-success-bg/40 text-status-success' : 'bg-brand-primary-light/10 text-brand-primary'
          }`}
        >
          💡 Keep your face in the frame, ensure enough light, look straight at the camera
        </div>
      )}

      {/* Camera — showPreview=false keeps it live; scanning overlay added inside WebcamCapture */}
      <WebcamCapture
        onCapture={handleCapture}
        isProcessing={processing}
        showPreview={false}
        buttonText={
          mode === 'check-in'
            ? 'Check in'
            : mode === 'check-out'
            ? 'Take time out'
            : mode === 'lunch-check-out'
            ? 'Lunch Break'
            : 'Back from Lunch'
        }
        width={480}
        height={360}
      />
    </div>
  );
}

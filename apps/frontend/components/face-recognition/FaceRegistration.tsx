'use client';

import { useState, useCallback, useEffect } from 'react';
import { getCompanyTz } from '@/utils/formatters';
import {
  UserCheck,
  Trash2,
  Upload,
  CheckCircle,
  AlertCircle,
  ImagePlus,
  Shield,
  ChevronLeft,
  ChevronRight,
  Focus,
} from 'lucide-react';
import WebcamCapture from './WebcamCapture';
import faceRecognitionService from '@/services/faceRecognitionService';
import type { FaceDescriptorInfo } from '@/services/faceRecognitionService';

interface FaceRegistrationProps {
  employeeId?: string;
  employeeName?: string;
  onRegistrationComplete?: () => void;
}

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3333';
const getImageUrl = (url: string | null | undefined): string | null => {
  if (!url) return null;
  if (url.startsWith('http')) return url;
  return `${BACKEND_URL}${url}`;
};

export default function FaceRegistration({
  employeeId,
  employeeName,
  onRegistrationComplete,
}: FaceRegistrationProps) {
  const [descriptors, setDescriptors] = useState<FaceDescriptorInfo[]>([]);
  const [totalRegistered, setTotalRegistered] = useState(0);
  const [maxAllowed, setMaxAllowed] = useState(5);
  const [loading, setLoading] = useState(true);
  const [registering, setRegistering] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [message, setMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);
  const [mode, setMode] = useState<'list' | 'webcam' | 'upload'>('list');

  // Guided step for the 3 mandatory captures (0=front, 1=left, 2=right)
  const REQUIRED_STEPS = [
    {
      label: 'Step 1/3 — Frontal',
      hint: 'Look straight at the camera, keeping your head straight',
      icon: <Focus className="h-5 w-5" />,
      color: 'blue',
    },
    {
      label: 'Step 2/3 — Lean slightly to the left',
      hint: 'Turn your head slightly to the left about 15-20°',
      icon: <ChevronLeft className="h-5 w-5" />,
      color: 'purple',
    },
    {
      label: 'Step 3/3 — Lean slightly to the right',
      hint: 'Turn your head slightly to the right about 15-20°',
      icon: <ChevronRight className="h-5 w-5" />,
      color: 'indigo',
    },
  ];

  const loadDescriptors = useCallback(async () => {
    try {
      setLoading(true);
      const response = employeeId
        ? await faceRecognitionService.getEmployeeDescriptors(employeeId)
        : await faceRecognitionService.getMyDescriptors();

      // Axios interceptor unwraps response.data → { success, data: [...] }
      const raw = (response as any).data ?? response;
      // Backend returns plain array in data field
      const descriptorsList: FaceDescriptorInfo[] = Array.isArray(raw)
        ? raw
        : (raw?.descriptors || []);
      setDescriptors(descriptorsList);
      setTotalRegistered(
        Array.isArray(raw) ? descriptorsList.length : (raw?.totalRegistered ?? descriptorsList.length)
      );
      setMaxAllowed(
        Array.isArray(raw) ? 5 : (raw?.maxAllowed || 5)
      );
    } catch (error) {
      console.error('Failed to load descriptors:', error);
    } finally {
      setLoading(false);
    }
  }, [employeeId]);

  useEffect(() => {
    loadDescriptors();
  }, [loadDescriptors]);

  const handleCapture = async (imageBase64: string) => {
    try {
      setRegistering(true);
      setMessage(null);

      const response = await faceRecognitionService.registerFace(
        imageBase64,
        employeeId,
      );

      // Axios interceptor unwraps response.data → outer: { success, message, data: {...} }
      const outer = response as any;
      const inner = outer?.data ?? outer;
      const successMsg = outer?.message || inner?.message || 'Face registration successful';
      // quality is a 0-1 float from the backend
      const qualityPct = Math.round((inner?.quality ?? 0) * 100);

      setMessage({
        type: 'success',
        text: `${successMsg} (Quality: ${qualityPct}%)`,
      });

      await loadDescriptors();

      const totalDone = inner?.totalRegistered ?? 0;
      if (totalDone >= 3) {
        onRegistrationComplete?.();
        // All required steps done → go back to list
        setTimeout(() => setMode('list'), 1200);
      }
      // else: stay in webcam mode → next required step will be shown automatically
    } catch (error: any) {
      const errMsg = error?.message || error?.data?.message || 'Face registration failed';
      setMessage({
        type: 'error',
        text: errMsg,
      });
    } finally {
      setRegistering(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file
    if (!file.type.startsWith('image/')) {
      setMessage({ type: 'error', text: 'Please select image file' });
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      setMessage({
        type: 'error',
        text: 'Photo is too large. Please choose photos under 5MB',
      });
      return;
    }

    // Convert to base64
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = reader.result as string;
      await handleCapture(base64);
    };
    reader.readAsDataURL(file);

    // Reset input
    e.target.value = '';
  };

  const handleDelete = async (descriptorId: string) => {
    if (!confirm('Are you sure you want to delete this face photo?')) return;

    try {
      setDeleting(descriptorId);
      await faceRecognitionService.deleteDescriptor(descriptorId);
      setMessage({ type: 'success', text: 'Face photo removed' });
      await loadDescriptors();
    } catch (error: any) {
      setMessage({
        type: 'error',
        text: error.message || 'Delete failed',
      });
    } finally {
      setDeleting(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-primary/10">
            <Shield className="h-4 w-4 text-brand-primary" />
          </div>
          <div>
            <h3 className="text-sm sm:text-base font-semibold text-text-heading">
              Face registration
              {employeeName && (
                <span className="text-brand-primary"> - {employeeName}</span>
              )}
            </h3>
            <p className="text-xs text-text-muted">
              Registered {totalRegistered}/3 required photos
              {totalRegistered >= 3 && maxAllowed > 3 && ` (maximum ${maxAllowed})`}
            </p>
          </div>
        </div>

        {/* Progress indicator — 3 required slots */}
        <div className="flex shrink-0 items-center gap-1.5">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className={`h-2.5 w-2.5 rounded-full ${
                i < totalRegistered ? 'bg-status-success' : 'bg-surface-border'
              }`}
            />
          ))}
        </div>
      </div>

      {/* Status message - only show in list mode; webcam mode has its own inline messages */}
      {message && mode === 'list' && (
        <div
          data-testid="facereg-message"
          data-kind={message.type}
          className={`flex items-start gap-2.5 rounded-lg border p-3 ${
            message.type === 'success'
              ? 'border-status-success/20 bg-status-success-bg/40 text-status-success'
              : 'border-status-error/20 bg-status-error-bg/40 text-status-error'
          }`}
        >
          {message.type === 'success' ? (
            <CheckCircle className="h-4 w-4 shrink-0 mt-0.5" />
          ) : (
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          )}
          <p className="text-xs sm:text-sm">{message.text}</p>
        </div>
      )}

      {/* Registration tip */}
      {totalRegistered < 3 && (
        <div className="bg-brand-primary/5 border border-brand-primary/15 rounded-lg p-3">
          <p className="text-xs font-medium text-text-heading">
            Face registration tips
          </p>
          <ul className="mt-1.5 list-inside list-disc space-y-1 text-xs text-text-muted">
            <li>Register at least 3 photos to increase accuracy</li>
            <li>Capture from different angles (straight, slightly left/right)</li>
            <li>Ensure adequate lighting, not dark or backlit</li>
            <li>Look straight at the camera, no dark glasses or mask</li>
          </ul>
        </div>
      )}

      {/* Mode: List */}
      {mode === 'list' && (
        <div>
          {/* Registered faces grid */}
          <span
            data-testid="facereg-panel"
            data-count={totalRegistered}
            data-max={maxAllowed}
            className="sr-only"
          />
          {descriptors.length > 0 && (
            <div className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-3 md:grid-cols-5">
              {descriptors.map((desc) => (
                <div
                  key={desc.id}
                  data-testid={`facereg-item-${desc.id}`}
                  data-quality={desc.quality}
                  className="group relative overflow-hidden rounded-[--radius-card] border border-surface-border bg-surface-card shadow-sm"
                >
                  {getImageUrl(desc.imageUrl) ? (
                    <img
                      src={getImageUrl(desc.imageUrl)!}
                      alt="Face"
                      className="aspect-square w-full object-cover"
                    />
                  ) : (
                    <div className="flex aspect-square items-center justify-center bg-surface-page">
                      <UserCheck className="h-8 w-8 text-text-muted" />
                    </div>
                  )}
                  <div className="p-2">
                    <p className="text-xs text-text-muted">
                      CL: {Math.round(desc.quality * 100)}%
                    </p>
                    <p className="text-xs text-text-muted opacity-80">
                      {new Date(desc.createdAt).toLocaleDateString('en-IN', { timeZone: getCompanyTz() })}
                    </p>
                  </div>
                  <button
                    data-testid={`facereg-delete-${desc.id}`}
                    onClick={() => handleDelete(desc.id)}
                    disabled={deleting === desc.id}
                    className="absolute right-1 top-1 rounded-full bg-status-error/80 p-1.5 text-text-on-brand opacity-0 transition-opacity hover:bg-status-error group-hover:opacity-100"
                  >
                    {deleting === desc.id ? (
                      <div className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    ) : (
                      <Trash2 className="h-3 w-3" />
                    )}
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Add more faces buttons */}
          {totalRegistered < maxAllowed && (
            <div className="flex flex-col sm:flex-row sm:items-center gap-2.5">
              <button
                onClick={() => { setMessage(null); setMode('webcam'); }}
                className="inline-flex items-center justify-center gap-2 h-10 px-4 rounded-lg bg-brand-primary hover:bg-brand-primary-dark text-white text-sm font-medium transition-colors w-full sm:w-auto"
              >
                <ImagePlus className="h-4 w-4" />
                {totalRegistered < 3
                  ? `Start registration (step ${totalRegistered + 1}/3)`
                  : 'Take more photos'}
              </button>

              <label className="inline-flex cursor-pointer items-center justify-center gap-2 h-9 px-3 rounded-lg border border-surface-border text-sm font-medium text-text-body transition-colors hover:bg-surface-page w-full sm:w-auto">
                <Upload className="h-4 w-4" />
                Upload photos
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleFileUpload}
                  className="hidden"
                />
              </label>
            </div>
          )}

          {totalRegistered >= maxAllowed && (
            <p data-testid="facereg-limit" className="text-xs text-status-warning">
              Limit of {maxAllowed} photos reached. Delete old photos to add new ones.
            </p>
          )}
        </div>
      )}

      {/* Mode: Webcam */}
      {mode === 'webcam' && (() => {
        const stepIdx = totalRegistered < 3 ? totalRegistered : null;
        const step = stepIdx !== null ? REQUIRED_STEPS[stepIdx] : null;
        const colorMap: Record<string, string> = {
          blue: 'border-brand-primary/20 bg-brand-primary-light/10 text-brand-primary',
          purple: 'border-brand-accent/20 bg-brand-accent/10 text-brand-accent',
          indigo: 'border-brand-primary/20 bg-brand-primary-light/10 text-brand-primary',
        };
        const iconMap: Record<string, string> = {
          blue: 'text-brand-primary',
          purple: 'text-brand-accent',
          indigo: 'text-brand-primary',
        };
        return (
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h4 className="text-sm font-medium text-text-body">
                Take a photo of your face ({totalRegistered + 1}/3)
              </h4>
              <button
                onClick={() => setMode('list')}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-surface-border px-3 text-sm font-medium text-text-body transition-colors hover:bg-surface-page"
              >
                <ChevronLeft className="h-4 w-4" />
                Go back
              </button>
            </div>

            {/* Step guide banner */}
            {step && (
              <div className={`mb-3 flex items-center gap-2.5 rounded-lg border p-3 ${
                colorMap[step.color]
              }`}>
                <div className={`shrink-0 ${iconMap[step.color]}`}>{step.icon}</div>
                <div>
                  <p className="text-xs sm:text-sm font-medium">{step.label}</p>
                  <p className="text-xs opacity-80">{step.hint}</p>
                </div>
                {/* dot progress */}
                <div className="ml-auto flex gap-1.5">
                  {REQUIRED_STEPS.map((_, i) => (
                    <div
                      key={i}
                      className={`h-2.5 w-2.5 rounded-full ${
                        i < totalRegistered
                          ? 'bg-status-success'
                          : i === totalRegistered
                          ? (step.color === 'purple' ? 'bg-brand-accent' : 'bg-brand-primary')
                          : 'bg-surface-border'
                      }`}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Success message for completed step */}
            {message?.type === 'success' && stepIdx !== null && (
              <div className="mb-3 flex items-start gap-2.5 rounded-lg border border-status-success/20 bg-status-success-bg/40 p-3 text-status-success text-xs sm:text-sm">
                <CheckCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>
                  {message.text}
                  {totalRegistered < 2 && (
                    <span className="ml-1 font-medium">Continue to the next angle.</span>
                  )}
                </span>
              </div>
            )}

            {/* Error message */}
            {message?.type === 'error' && (
              <div className="mb-3 flex items-start gap-2.5 rounded-lg border border-status-error/20 bg-status-error-bg/40 p-3 text-status-error text-xs sm:text-sm">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                {message.text}
              </div>
            )}

            <WebcamCapture
              key={totalRegistered}
              onCapture={handleCapture}
              isProcessing={registering}
              buttonText={step ? `Capture ${step.label}` : 'Capture & Register'}
              width={480}
              height={360}
            />
          </div>
        );
      })()}
    </div>
  );
}

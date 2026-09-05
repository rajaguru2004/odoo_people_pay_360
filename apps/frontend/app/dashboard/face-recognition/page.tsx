'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Camera,
  ScanFace,
  ShieldCheck,
  ShieldX,
  TriangleAlert,
} from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useAuthStore } from '@/store/authStore';
import {
  useMyFaceEnrollmentStatus,
  useVerifyFace,
} from '@/hooks/useFaceEnrollments';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/common/EmptyState';
import { StatCard } from '@/components/common/StatCard';
import {
  describeQuality,
  getFaceRecogniser,
  isUsableSample,
  type FaceSample,
} from '@/components/attendance/faceCapture';
import { formatDateTime } from '@/utils/formatDate';
import { apiErrorMessage } from '@/utils/apiError';
import { fullName } from '@/utils/formatters';
import type { FaceVerifyResult } from '@/types/attendance';

/** What the person did, and what happened, in one sentence each. */
const STEPS = [
  {
    title: 'Face the camera',
    body: 'Head straight on, eyes open, nothing across your face. A template built from a turned head matches a turned head and little else.',
  },
  {
    title: 'Find some light',
    body: 'Even light on the face beats bright light behind it. A silhouette carries almost no detail for the recogniser to work with.',
  },
  {
    title: 'Capture',
    body: 'The frame is turned into a template on this device. The photo itself is never uploaded.',
  },
  {
    title: 'Verify',
    body: 'Only the template travels, and only upwards. It is compared against what is on file and discarded.',
  },
];

function Verification() {
  const user = useAuthStore((s) => s.user);
  const employeeId = user?.employeeId ?? user?.employee?.id ?? undefined;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  // The probe lives in a ref, not in state. State is what renders, and a
  // template that reaches the render tree has left the one place it belongs.
  const sampleRef = useRef<FaceSample | null>(null);

  const [captured, setCaptured] = useState<{ quality: number } | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<FaceVerifyResult | null>(null);

  const status = useMyFaceEnrollmentStatus();
  const verify = useVerifyFace();
  const recogniser = getFaceRecogniser();

  usePageHeader(
    'Biometric verification',
    'Check that the face on file still recognises you',
  );

  useEffect(() => {
    let stream: MediaStream | undefined;
    let cancelled = false;

    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: 'user' } })
      .then((granted) => {
        if (cancelled) {
          granted.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = granted;
        if (videoRef.current) videoRef.current.srcObject = granted;
      })
      .catch(() => setCameraError('This browser would not open the camera.'));

    // Every track has to be stopped by hand. Unmounting the element leaves the
    // camera running and the indicator light on.
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  const capture = async () => {
    if (!recogniser || !videoRef.current) return;
    try {
      const sample = await recogniser.describe(videoRef.current);
      if (!sample) {
        toast.error('No face was found in the frame');
        return;
      }
      if (!isUsableSample(sample)) {
        toast.error('That capture is not a usable template — try again in better light');
        return;
      }
      sampleRef.current = sample;
      setVerdict(null);
      // Only the confidence crosses into state.
      setCaptured({ quality: sample.quality });
    } catch (error) {
      toast.error(apiErrorMessage(error, 'The capture failed'));
    }
  };

  const submit = async () => {
    const sample = sampleRef.current;
    if (!sample) return;
    try {
      const response = await verify.mutateAsync({
        descriptor: sample.descriptor,
        // Verified against THIS person rather than searched across everybody.
        // The question on this screen is "does the face on file still recognise
        // me", and searching the whole workforce answers a different one.
        ...(employeeId ? { employeeId } : {}),
      });
      setVerdict(response.data);
    } catch (error) {
      toast.error(apiErrorMessage(error, 'The verification failed'));
    }
  };

  const enrolment = status.data?.data;
  const quality = captured ? describeQuality(captured.quality) : null;

  return (
    <div className="space-y-5">
      <Link
        href="/dashboard/my-attendance"
        className="inline-flex items-center gap-2 text-sm text-text-body hover:text-text-heading"
      >
        <ArrowLeft className="h-4 w-4 rtl:rotate-180" aria-hidden />
        Back to my attendance
      </Link>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Enrolment"
          value={enrolment?.isRegistered ? 'On file' : 'None'}
          hint={
            enrolment?.isRegistered
              ? `${enrolment.totalRegistered} template${
                  enrolment.totalRegistered === 1 ? '' : 's'
                }`
              : 'Ask HR to enrol you'
          }
          icon={<ScanFace className="h-5 w-5" aria-hidden />}
        />
        <StatCard
          label="Best capture"
          value={
            enrolment?.bestQuality === null || enrolment?.bestQuality === undefined
              ? '—'
              : `${Math.round(enrolment.bestQuality * 100)}%`
          }
          hint="What the matching actually uses"
        />
        <StatCard
          label="Last enrolled"
          value={enrolment?.lastEnrolledAt ? formatDateTime(enrolment.lastEnrolledAt) : '—'}
          hint={
            enrolment
              ? `Matches within ${enrolment.threshold} distance`
              : undefined
          }
        />
      </div>

      {enrolment && !enrolment.isRegistered && (
        <Card>
          <EmptyState
            icon={<TriangleAlert className="h-6 w-6" aria-hidden />}
            title="You have no face template on file"
            description="There is nothing to verify against yet. Enrolment happens at an attendance terminal, with HR — a template captured here by a different model than the one doing the matching would recognise nobody."
          />
        </Card>
      )}

      <Card>
        <CardHeader
          title="Verify now"
          subtitle="The captured template is compared on the server and discarded. Nothing is stored by this screen."
        />
        <CardBody className="space-y-4">
          <div className="overflow-hidden rounded-[var(--radius-card)] border border-surface-border bg-surface-page">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              aria-label="Camera preview"
              className="h-64 w-full object-cover"
            />
          </div>

          {cameraError && <p className="text-sm text-status-error">{cameraError}</p>}

          {!recogniser && (
            <p className="flex items-start gap-2 rounded-[var(--radius-card)] border border-status-warning/30 bg-status-warning-bg px-3 py-2 text-sm text-status-warning">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>
                No face recogniser is loaded on this device, so a template cannot be
                captured here. Verify at an attendance terminal instead.
              </span>
            </p>
          )}

          {quality && (
            <p
              className={`text-sm font-medium ${
                quality.weak ? 'text-status-warning' : 'text-status-success'
              }`}
            >
              Capture quality: {quality.label}
              {quality.weak ? ' — take it again before verifying.' : ''}
            </p>
          )}

          {verdict && (
            <div
              className={`flex items-start gap-3 rounded-[var(--radius-card)] border px-4 py-3 ${
                verdict.matched
                  ? 'border-status-success/30 bg-status-success-bg'
                  : 'border-status-error/30 bg-status-error-bg'
              }`}
              role="status"
            >
              <span className="mt-0.5 shrink-0">
                {verdict.matched ? (
                  <ShieldCheck className="h-5 w-5 text-status-success" aria-hidden />
                ) : (
                  <ShieldX className="h-5 w-5 text-status-error" aria-hidden />
                )}
              </span>
              <div>
                <p className="text-sm font-semibold text-text-heading">
                  {verdict.matched ? 'Recognised' : 'Not recognised'}
                </p>
                <p className="mt-0.5 text-sm text-text-muted">
                  {verdict.matched ? (
                    <>
                      Matched {fullName(verdict.employee)} at {verdict.confidence}%
                      confidence.
                    </>
                  ) : verdict.candidates === 0 ? (
                    'There is no template on file to compare against.'
                  ) : (
                    // Deliberately silent about who was nearest. The server does
                    // not say, and it is right not to.
                    'The capture did not clear the matching threshold. Try again in better light, or ask HR to re-enrol you.'
                  )}
                </p>
                {verdict.matched && (
                  <Badge tone="success">
                    Threshold {verdict.threshold}
                  </Badge>
                )}
              </div>
            </div>
          )}

          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={() => void capture()} disabled={!recogniser}>
              <Camera className="h-4 w-4" aria-hidden />
              Capture
            </Button>
            <Button
              onClick={() => void submit()}
              isLoading={verify.isPending}
              disabled={!captured}
            >
              <ScanFace className="h-4 w-4" aria-hidden />
              Verify
            </Button>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="How it works" />
        <CardBody>
          <ol className="grid gap-3 sm:grid-cols-2">
            {STEPS.map((step, index) => (
              <li
                key={step.title}
                className="rounded-[var(--radius-card)] border border-surface-border-light bg-surface-page p-3"
              >
                <p className="text-sm font-medium text-text-heading">
                  {index + 1}. {step.title}
                </p>
                <p className="mt-1 text-xs text-text-muted">{step.body}</p>
              </li>
            ))}
          </ol>
        </CardBody>
      </Card>
    </div>
  );
}

export default function FaceRecognitionPage() {
  return (
    <ProtectedRoute>
      <Verification />
    </ProtectedRoute>
  );
}

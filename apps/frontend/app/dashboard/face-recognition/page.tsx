'use client';

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useMyFaceEnrollmentStatus } from '@/hooks/useFaceEnrollments';
import { FaceRegistration } from '@/components/face-recognition';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';

/** What the person does, and why it is asked for, in one sentence each. */
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
    title: 'Capture three angles',
    body: 'Straight on, then a small turn each way. Three poses is what makes a terminal recognise you when you glance at it rather than stare.',
  },
  {
    title: 'That is all',
    body: 'The photo becomes a template on the server. The template is what a terminal matches against, and it never travels back to a browser.',
  },
];

function Registration() {
  const status = useMyFaceEnrollmentStatus();
  const enrolment = status.data?.data;

  usePageHeader(
    'Biometric registration',
    'Register the face a terminal will recognise you by',
  );

  return (
    <div className="space-y-4">
      <Link
        href="/dashboard/my-attendance"
        className="inline-flex items-center gap-2 text-sm text-text-body hover:text-text-heading"
      >
        <ArrowLeft className="h-4 w-4 rtl:rotate-180" aria-hidden />
        Back to my attendance
      </Link>

      {enrolment && (
        <Card className="p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <h3 className="text-sm font-semibold text-text-heading">Status</h3>
              <span
                data-testid="face-status"
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  enrolment.isRegistered
                    ? 'bg-status-success-bg text-status-success'
                    : 'bg-status-warning-bg text-status-warning'
                }`}
              >
                {enrolment.isRegistered
                  ? `${enrolment.totalRegistered} capture${
                      enrolment.totalRegistered === 1 ? '' : 's'
                    } on file`
                  : 'Not registered yet'}
              </span>
            </div>

            {enrolment.isRegistered && (
              <Link
                href="/dashboard/my-attendance"
                className="inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-surface-border px-4 text-sm font-medium text-text-body transition-colors hover:bg-surface-page md:h-9 md:px-3"
              >
                Go to face attendance
              </Link>
            )}
          </div>
        </Card>
      )}

      <Card className="p-4 sm:p-5">
        <FaceRegistration onRegistrationComplete={() => void status.refetch()} />
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
      <Registration />
    </ProtectedRoute>
  );
}

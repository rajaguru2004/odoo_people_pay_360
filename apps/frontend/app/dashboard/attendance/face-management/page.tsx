'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Camera, ScanFace, ShieldCheck, Trash2, TriangleAlert, X } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import {
  useCreateFaceEnrollment,
  useDeleteFaceEnrollment,
  useFaceEnrollments,
} from '@/hooks/useFaceEnrollments';
import { useEmployees } from '@/hooks/useEmployees';
import { useAuthStore } from '@/store/authStore';
import settingsService from '@/services/settingsService';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Select } from '@/components/ui/Select';
import { EmptyState } from '@/components/common/EmptyState';
import { StatCard } from '@/components/common/StatCard';
import {
  MIN_ENROLMENT_QUALITY,
  describeQuality,
  getFaceRecogniser,
  isUsableSample,
  type FaceSample,
} from '@/components/attendance/faceCapture';
import { formatDate } from '@/utils/formatDate';
import { apiErrorMessage } from '@/utils/apiError';
import { fullName } from '@/utils/formatters';

/**
 * The enrolment dialog.
 *
 * The captured descriptor is held in a ref and posted from there. It is never
 * put in state, because state is what renders — and a template that reaches the
 * screen has left the one place it is allowed to be.
 */
function EnrolDialog({
  minimum,
  onClose,
}: {
  minimum: number;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const sampleRef = useRef<FaceSample | null>(null);
  const [employeeId, setEmployeeId] = useState('');
  const [captured, setCaptured] = useState<{ quality: number } | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);

  const employees = useEmployees({ limit: 200, status: 'ACTIVE', sortBy: 'firstName' });
  const create = useCreateFaceEnrollment();
  const recogniser = getFaceRecogniser();

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

    // The camera keeps running until every track is stopped, so a dialog that
    // only unmounts leaves the indicator light on.
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
      // Only the confidence crosses into state. The descriptor stays in the ref.
      setCaptured({ quality: sample.quality });
    } catch (error) {
      toast.error(apiErrorMessage(error, 'The capture failed'));
    }
  };

  const submit = async () => {
    const sample = sampleRef.current;
    if (!employeeId || !sample) return;
    try {
      await create.mutateAsync({
        employeeId,
        descriptor: sample.descriptor,
        quality: sample.quality,
      });
      toast.success('Enrolled');
      onClose();
    } catch (error) {
      toast.error(apiErrorMessage(error));
    }
  };

  const quality = captured ? describeQuality(captured.quality, minimum) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <Card className="w-full max-w-md p-5">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-text-heading">Enrol a face</h2>
            <p className="mt-0.5 text-sm text-text-muted">
              The template is sent once and never comes back.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-[var(--radius-button)] p-1 text-text-muted hover:bg-surface-border-light"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="space-y-3">
          <Select
            label="Person"
            placeholder="Choose an employee"
            value={employeeId}
            onChange={(event) => setEmployeeId(event.target.value)}
          >
            {(employees.data?.data ?? []).map((employee) => (
              <option key={employee.id} value={employee.id}>
                {fullName(employee)} · {employee.employeeCode}
              </option>
            ))}
          </Select>

          <div className="overflow-hidden rounded-[var(--radius-card)] border border-surface-border bg-surface-page">
            <video ref={videoRef} autoPlay playsInline muted className="h-48 w-full object-cover" />
          </div>

          {cameraError && <p className="text-sm text-status-error">{cameraError}</p>}

          {!recogniser && (
            <p className="flex items-start gap-2 rounded-[var(--radius-card)] border border-status-warning/30 bg-status-warning-bg px-3 py-2 text-sm text-status-warning">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>
                No face recogniser is loaded on this device, so a template cannot be captured
                here. Enrol from an attendance terminal — a template built by a different model
                than the one doing the matching would never recognise anybody.
              </span>
            </p>
          )}

          {quality && (
            <p
              className={`text-sm font-medium ${
                quality.weak ? 'text-status-warning' : 'text-status-success'
              }`}
            >
              Quality: {quality.label}
              {quality.weak ? ' — capture it again before saving.' : ''}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="outline" onClick={() => void capture()} disabled={!recogniser}>
              <Camera className="h-4 w-4" aria-hidden />
              Capture
            </Button>
            <Button
              onClick={() => void submit()}
              isLoading={create.isPending}
              disabled={!employeeId || !captured}
            >
              Save
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

function BiometricEnrolment() {
  const role = useAuthStore((s) => s.user?.role);
  const [enrolling, setEnrolling] = useState(false);

  const { data, isLoading, isError } = useFaceEnrollments();
  const remove = useDeleteFaceEnrollment();

  /**
   * The configured floor, when the caller may read it.
   *
   * `GET /system-settings` is administrators only, and a request that 403s would
   * put the shared permission modal on screen for every HR manager who opened
   * this page. They get the same default the server applies instead.
   */
  const settings = useQuery({
    queryKey: ['system-settings', 'face-minimum'],
    queryFn: () => settingsService.getAll(),
    enabled: role === 'ADMIN',
    retry: false,
    staleTime: 5 * 60_000,
  });

  const minimum = useMemo(() => {
    const raw = Number(settings.data?.data?.face_recognition_min_quality);
    return Number.isFinite(raw) ? raw : MIN_ENROLMENT_QUALITY;
  }, [settings.data]);

  const enrolments = data?.data ?? [];
  const weak = enrolments.filter((row) => row.quality < minimum).length;

  usePageHeader(
    'Biometric enrolment',
    data?.meta ? `${data.meta.total} template${data.meta.total === 1 ? '' : 's'}` : undefined,
  );

  const drop = async (id: string, name: string) => {
    if (!window.confirm(`Delete the template for ${name}? They will have to enrol again.`)) return;
    try {
      await remove.mutateAsync(id);
      toast.success('Template deleted');
    } catch (error) {
      toast.error(apiErrorMessage(error));
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-end gap-3">
        <Button onClick={() => setEnrolling(true)}>
          <ScanFace className="h-4 w-4" aria-hidden />
          Enrol a face
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Templates held"
          value={data?.meta?.total ?? enrolments.length}
          icon={<ShieldCheck className="h-5 w-5" aria-hidden />}
        />
        <StatCard
          label="Weak templates"
          value={weak}
          hint={`Below the ${Math.round(minimum * 100)}% minimum`}
          icon={<TriangleAlert className="h-5 w-5" aria-hidden />}
        />
        <StatCard
          label="Minimum quality"
          value={`${Math.round(minimum * 100)}%`}
          hint={role === 'ADMIN' ? 'From system settings' : 'The platform default'}
        />
      </div>

      <Card>
        <div className="border-b border-surface-border-light px-5 py-4">
          <h3 className="text-base font-semibold text-text-heading">Enrolled faces</h3>
          {/* Stated plainly, because it is the reason this screen has no photo
              gallery and no "view template" action. */}
          <p className="mt-0.5 text-sm text-text-muted">
            The stored template never leaves the server — this list carries only who is enrolled,
            how good the capture was, and when it was taken.
          </p>
        </div>

        {isLoading && <p className="p-6 text-sm text-text-muted">Loading enrolments…</p>}

        {isError && (
          <p className="p-6 text-sm text-status-error">
            Could not load the enrolments. Is the API running?
          </p>
        )}

        {!isLoading && !isError && enrolments.length === 0 && (
          <EmptyState
            icon={<ScanFace className="h-6 w-6" aria-hidden />}
            title="Nobody is enrolled"
            description="Enrol a face from an attendance terminal to start matching punches."
          />
        )}

        {enrolments.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-sm">
              <thead className="border-b border-surface-border-light text-xs uppercase tracking-wide text-text-muted">
                <tr>
                  <th className="px-5 py-3 text-start font-medium">Employee</th>
                  <th className="px-5 py-3 text-start font-medium">Department</th>
                  <th className="px-5 py-3 text-start font-medium">Quality</th>
                  <th className="px-5 py-3 text-start font-medium">Enrolled</th>
                  <th className="px-5 py-3 text-end font-medium">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border-light">
                {enrolments.map((row) => {
                  const quality = describeQuality(row.quality, minimum);
                  const name = fullName(row.employee);
                  return (
                    <tr key={row.id} className="hover:bg-surface-border-light/60">
                      <td className="px-5 py-3">
                        <p className="font-medium text-text-heading">{name}</p>
                        <p className="text-xs text-text-muted">
                          {row.employee?.employeeCode ?? '—'}
                        </p>
                      </td>
                      <td className="px-5 py-3 text-text-body">
                        {row.employee?.department?.name ?? '—'}
                      </td>
                      <td className="px-5 py-3">
                        {/* A weak template is named, not scored: "0.41" is not
                            something an HR manager can act on, "re-enrol" is. */}
                        <Badge tone={quality.weak ? 'warning' : 'success'}>{quality.label}</Badge>
                      </td>
                      <td className="px-5 py-3 tabular-nums text-text-body">
                        {formatDate(row.createdAt)}
                      </td>
                      <td className="px-5 py-3 text-end">
                        <Button
                          size="sm"
                          variant="danger"
                          isLoading={remove.isPending}
                          onClick={() => void drop(row.id, name)}
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden />
                          Delete
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {enrolling && <EnrolDialog minimum={minimum} onClose={() => setEnrolling(false)} />}
    </div>
  );
}

export default function FaceManagementPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER']}>
      <BiometricEnrolment />
    </ProtectedRoute>
  );
}

'use client';

import { useState } from 'react';
import {
  BookOpen,
  CalendarDays,
  Check,
  GraduationCap,
  Plus,
  UserPlus,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { EmptyState } from '@/components/common/EmptyState';
import { StatCard } from '@/components/common/StatCard';
import { usePageHeader } from '@/hooks/usePageHeader';
import {
  useCourses,
  useCreateCourse,
  useCreateSession,
  useDecideNomination,
  useNominate,
  useNominations,
  useRecordAttendance,
  useTrainingSessions,
  useTrainingStats,
} from '@/hooks/useTraining';
import { useBranches } from '@/hooks/useBranches';
import { useEmployees } from '@/hooks/useEmployees';
import { useLibraryItems } from '@/hooks/useLibraryItems';
import { useAuthStore } from '@/store/authStore';
import { apiErrorMessage } from '@/utils/apiError';
import { formatDateOnly } from '@/utils/formatDate';
import { fullName } from '@/utils/formatters';
import type {
  CreateCourseData,
  CreateSessionData,
  NominationStatus,
  TrainingNomination,
  TrainingSession,
} from '@/types/training';

type Tab = 'sessions' | 'nominations' | 'courses';

const TABS: { value: Tab; label: string }[] = [
  { value: 'sessions', label: 'Sessions' },
  { value: 'nominations', label: 'Nominations' },
  { value: 'courses', label: 'Courses' },
];

const STATUS_TONE: Record<
  NominationStatus,
  'neutral' | 'success' | 'warning' | 'error' | 'info'
> = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'error',
  CANCELLED: 'neutral',
  ATTENDED: 'info',
  NO_SHOW: 'warning',
};

const EMPTY_COURSE: CreateCourseData = { code: '', title: '' };
const EMPTY_SESSION: CreateSessionData = {
  courseId: '',
  startDate: '',
  endDate: '',
};

function TrainingScreen() {
  const role = useAuthStore((state) => state.user?.role);
  const isHr = role === 'ADMIN' || role === 'HR_MANAGER';

  const [tab, setTab] = useState<Tab>('sessions');
  const [showCourseForm, setShowCourseForm] = useState(false);
  const [courseForm, setCourseForm] = useState<CreateCourseData>(EMPTY_COURSE);
  const [showSessionForm, setShowSessionForm] = useState(false);
  const [sessionForm, setSessionForm] = useState<CreateSessionData>(EMPTY_SESSION);

  const [nominateFor, setNominateFor] = useState<TrainingSession | null>(null);
  const [nomineeId, setNomineeId] = useState('');
  const [justification, setJustification] = useState('');

  const [attendanceFor, setAttendanceFor] = useState<TrainingNomination | null>(null);
  const [score, setScore] = useState('');
  const [passed, setPassed] = useState(true);

  const stats = useTrainingStats(isHr);
  const courses = useCourses();
  const sessions = useTrainingSessions();
  const nominations = useNominations({});
  const branches = useBranches();
  const people = useEmployees({ status: 'ACTIVE', limit: 200, sortBy: 'firstName' });
  const categories = useLibraryItems({ type: 'COURSE_CATEGORY', activeOnly: true });

  const createCourse = useCreateCourse();
  const createSession = useCreateSession();
  const nominate = useNominate();
  const decide = useDecideNomination();
  const recordAttendance = useRecordAttendance();

  const courseRows = courses.data?.data ?? [];
  const sessionRows = sessions.data?.data ?? [];
  const nominationRows = nominations.data?.data ?? [];
  const figures = stats.data?.data;
  const activeCourses = courseRows.filter((course) => course.isActive);

  usePageHeader(
    'Training',
    'The course catalogue, its sessions, and who is booked on them',
  );

  const submitCourse = async () => {
    if (!courseForm.code.trim() || !courseForm.title.trim()) {
      toast.warning('A code and a title are both needed');
      return;
    }
    try {
      await createCourse.mutateAsync({
        ...courseForm,
        code: courseForm.code.trim(),
        title: courseForm.title.trim(),
      });
      toast.success('Course added');
      setShowCourseForm(false);
      setCourseForm(EMPTY_COURSE);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not add that course.'));
    }
  };

  const submitSession = async () => {
    if (!sessionForm.courseId || !sessionForm.startDate || !sessionForm.endDate) {
      toast.warning('A course and both dates are needed');
      return;
    }
    try {
      await createSession.mutateAsync(sessionForm);
      toast.success('Session scheduled');
      setShowSessionForm(false);
      setSessionForm(EMPTY_SESSION);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not schedule that session.'));
    }
  };

  const submitNomination = async () => {
    if (!nominateFor || !nomineeId) {
      toast.warning('Choose who is being nominated');
      return;
    }
    try {
      await nominate.mutateAsync({
        sessionId: nominateFor.id,
        employeeId: nomineeId,
        justification: justification.trim() || undefined,
      });
      toast.success('Nominated');
      setNominateFor(null);
      setNomineeId('');
      setJustification('');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not nominate.'));
    }
  };

  const submitDecision = async (
    nomination: TrainingNomination,
    decision: 'approve' | 'reject',
  ) => {
    try {
      await decide.mutateAsync({ id: nomination.id, decision });
      toast.success(decision === 'approve' ? 'Approved' : 'Rejected');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not record that decision.'));
    }
  };

  const submitAttendance = async (attended: boolean) => {
    if (!attendanceFor) return;
    try {
      await recordAttendance.mutateAsync({
        id: attendanceFor.id,
        payload: {
          attended,
          score: score ? Number(score) : undefined,
          passed: attended ? passed : undefined,
        },
      });
      toast.success('Attendance recorded');
      setAttendanceFor(null);
      setScore('');
      setPassed(true);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not record attendance.'));
    }
  };

  return (
    <div className="space-y-5">
      {figures && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard
            label="Active courses"
            value={figures.activeCourses}
            icon={<BookOpen className="h-5 w-5" aria-hidden />}
          />
          <StatCard
            label="Starting in 30 days"
            value={figures.upcomingSessions30Days}
            icon={<CalendarDays className="h-5 w-5" aria-hidden />}
          />
          <StatCard
            label="Awaiting a decision"
            value={figures.nominationsByStatus.PENDING ?? 0}
          />
          <StatCard
            label="Seats committed"
            value={
              (figures.nominationsByStatus.APPROVED ?? 0) +
              (figures.nominationsByStatus.ATTENDED ?? 0)
            }
          />
        </div>
      )}

      <div
        role="tablist"
        aria-label="Training views"
        className="inline-flex gap-1 rounded-[var(--radius-input)] border border-surface-border bg-surface-page p-1"
      >
        {TABS.map((entry) => (
          <button
            key={entry.value}
            type="button"
            role="tab"
            aria-selected={tab === entry.value}
            onClick={() => setTab(entry.value)}
            className={
              tab === entry.value
                ? 'rounded-[var(--radius-button)] bg-surface-card px-3 py-1.5 text-sm font-medium text-text-heading'
                : 'rounded-[var(--radius-button)] px-3 py-1.5 text-sm font-medium text-text-muted hover:text-text-body'
            }
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === 'sessions' && (
        <div className="space-y-4">
          {isHr && (
            <div className="flex justify-end">
              <Button
                onClick={() => setShowSessionForm((open) => !open)}
                disabled={activeCourses.length === 0}
                data-testid="session-new"
              >
                <Plus className="h-4 w-4" aria-hidden />
                Schedule a session
              </Button>
            </div>
          )}

          {isHr && activeCourses.length === 0 && (
            <Card className="p-4">
              <p className="text-sm text-text-muted">
                A session is a sitting of a course, so the catalogue has to have
                one first. Add a course on the Courses tab.
              </p>
            </Card>
          )}

          {showSessionForm && isHr && (
            <Card className="p-5">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-text-heading">
                  New session
                </h2>
                <button
                  type="button"
                  onClick={() => setShowSessionForm(false)}
                  aria-label="Close the session form"
                  className="text-text-muted hover:text-text-body"
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              </div>
              <div className="grid gap-3 md:grid-cols-3">
                <Select
                  label="Course"
                  placeholder="Choose a course…"
                  value={sessionForm.courseId}
                  onChange={(event) =>
                    setSessionForm({ ...sessionForm, courseId: event.target.value })
                  }
                  data-testid="session-form-course"
                >
                  {activeCourses.map((course) => (
                    <option key={course.id} value={course.id}>
                      {course.code} — {course.title}
                    </option>
                  ))}
                </Select>
                <Input
                  label="Starts"
                  type="date"
                  value={sessionForm.startDate}
                  onChange={(event) =>
                    setSessionForm({ ...sessionForm, startDate: event.target.value })
                  }
                  data-testid="session-form-start"
                />
                <Input
                  label="Ends"
                  type="date"
                  value={sessionForm.endDate}
                  onChange={(event) =>
                    setSessionForm({ ...sessionForm, endDate: event.target.value })
                  }
                  data-testid="session-form-end"
                />
                <Select
                  label="Branch"
                  placeholder="Open to every branch"
                  value={sessionForm.branchId ?? ''}
                  onChange={(event) =>
                    setSessionForm({
                      ...sessionForm,
                      branchId: event.target.value || undefined,
                    })
                  }
                >
                  {(branches.data?.data ?? []).map((branch) => (
                    <option key={branch.id} value={branch.id}>
                      {branch.name}
                    </option>
                  ))}
                </Select>
                <Input
                  label="Location"
                  value={sessionForm.location ?? ''}
                  onChange={(event) =>
                    setSessionForm({ ...sessionForm, location: event.target.value })
                  }
                />
                <Input
                  label="Seats"
                  type="number"
                  min={1}
                  value={sessionForm.seats ?? ''}
                  onChange={(event) =>
                    setSessionForm({
                      ...sessionForm,
                      seats: event.target.value ? Number(event.target.value) : undefined,
                    })
                  }
                />
              </div>
              <div className="mt-4 flex justify-end">
                <Button
                  onClick={() => void submitSession()}
                  isLoading={createSession.isPending}
                  data-testid="session-form-submit"
                >
                  Schedule
                </Button>
              </div>
            </Card>
          )}

          <Card>
            {sessions.isLoading && (
              <p className="p-6 text-sm text-text-muted">Loading sessions…</p>
            )}
            {!sessions.isLoading && sessionRows.length === 0 && (
              <EmptyState
                icon={<CalendarDays className="h-6 w-6" aria-hidden />}
                title="No sessions scheduled"
                description="Schedule a sitting of a course to start taking nominations."
              />
            )}
            {sessionRows.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] text-sm">
                  <thead className="border-b border-surface-border-light text-xs uppercase tracking-wide text-text-muted">
                    <tr>
                      <th scope="col" className="px-5 py-3 text-start font-medium">Course</th>
                      <th scope="col" className="px-5 py-3 text-start font-medium">Dates</th>
                      <th scope="col" className="px-5 py-3 text-start font-medium">Location</th>
                      <th scope="col" className="px-5 py-3 text-start font-medium">Seats</th>
                      <th scope="col" className="px-5 py-3 text-start font-medium">Status</th>
                      {isHr && (
                        <th scope="col" className="px-5 py-3 text-end font-medium">Actions</th>
                      )}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-surface-border-light">
                    {sessionRows.map((session) => (
                      <tr
                        key={session.id}
                        data-testid={`session-row-${session.id}`}
                        className="hover:bg-surface-border-light/60"
                      >
                        <td className="px-5 py-3">
                          <p className="font-medium text-text-heading">
                            {session.course?.title}
                          </p>
                          <p className="text-xs text-text-muted">
                            {session.course?.code}
                          </p>
                        </td>
                        <td className="px-5 py-3 text-text-muted">
                          {formatDateOnly(session.startDate)} →{' '}
                          {formatDateOnly(session.endDate)}
                        </td>
                        <td className="px-5 py-3 text-text-muted">
                          {session.location ?? '—'}
                        </td>
                        <td className="px-5 py-3 tabular-nums text-text-muted">
                          {session._count?.nominations ?? 0}
                          {session.seats ? ` / ${session.seats}` : ''}
                        </td>
                        <td className="px-5 py-3">
                          <Badge
                            tone={session.status === 'SCHEDULED' ? 'info' : 'neutral'}
                          >
                            {session.status}
                          </Badge>
                        </td>
                        {isHr && (
                          <td className="px-5 py-3 text-end">
                            {session.status === 'SCHEDULED' && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setNominateFor(session)}
                                data-testid={`session-nominate-${session.id}`}
                              >
                                <UserPlus className="h-4 w-4" aria-hidden />
                                Nominate
                              </Button>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}

      {tab === 'nominations' && (
        <Card>
          {nominations.isLoading && (
            <p className="p-6 text-sm text-text-muted">Loading nominations…</p>
          )}
          {!nominations.isLoading && nominationRows.length === 0 && (
            <EmptyState
              icon={<GraduationCap className="h-6 w-6" aria-hidden />}
              title="Nobody nominated yet"
              description="Nominate somebody from a scheduled session and their decision lands here."
            />
          )}
          {nominationRows.length > 0 && (
            <ul className="divide-y divide-surface-border-light">
              {nominationRows.map((nomination) => (
                <li
                  key={nomination.id}
                  data-testid={`nomination-row-${nomination.id}`}
                  className="flex flex-wrap items-start justify-between gap-3 px-5 py-4"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-text-heading">
                        {nomination.employee?.fullName}
                      </p>
                      <Badge tone={STATUS_TONE[nomination.status]}>
                        {nomination.status}
                      </Badge>
                    </div>
                    <p className="mt-0.5 text-xs text-text-muted">
                      {nomination.session?.course?.title} ·{' '}
                      {formatDateOnly(nomination.session?.startDate)}
                      {nomination.employee?.department
                        ? ` · ${nomination.employee.department.name}`
                        : ''}
                    </p>
                    {nomination.justification && (
                      <p className="mt-1 text-xs italic text-text-muted">
                        “{nomination.justification}”
                      </p>
                    )}
                  </div>

                  {isHr && (
                    <div className="flex items-center gap-2">
                      {nomination.status === 'PENDING' && (
                        <>
                          <Button
                            size="sm"
                            onClick={() => void submitDecision(nomination, 'approve')}
                            data-testid={`nomination-approve-${nomination.id}`}
                          >
                            <Check className="h-4 w-4" aria-hidden />
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void submitDecision(nomination, 'reject')}
                            data-testid={`nomination-reject-${nomination.id}`}
                          >
                            <X className="h-4 w-4" aria-hidden />
                            Reject
                          </Button>
                        </>
                      )}
                      {nomination.status === 'APPROVED' && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setAttendanceFor(nomination)}
                          data-testid={`nomination-attendance-${nomination.id}`}
                        >
                          Record attendance
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {tab === 'courses' && (
        <div className="space-y-4">
          {isHr && (
            <div className="flex justify-end">
              <Button
                onClick={() => setShowCourseForm((open) => !open)}
                data-testid="course-new"
              >
                <Plus className="h-4 w-4" aria-hidden />
                Add a course
              </Button>
            </div>
          )}

          {showCourseForm && isHr && (
            <Card className="p-5">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-text-heading">New course</h2>
                <button
                  type="button"
                  onClick={() => setShowCourseForm(false)}
                  aria-label="Close the course form"
                  className="text-text-muted hover:text-text-body"
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              </div>
              <div className="grid gap-3 md:grid-cols-3">
                <Input
                  label="Code"
                  placeholder="SEC-101"
                  value={courseForm.code}
                  onChange={(event) =>
                    setCourseForm({ ...courseForm, code: event.target.value })
                  }
                  data-testid="course-form-code"
                />
                <Input
                  label="Title"
                  placeholder="Information Security Awareness"
                  value={courseForm.title}
                  onChange={(event) =>
                    setCourseForm({ ...courseForm, title: event.target.value })
                  }
                  data-testid="course-form-title"
                />
                <Select
                  label="Category"
                  placeholder="Uncategorised"
                  value={courseForm.category ?? ''}
                  onChange={(event) =>
                    setCourseForm({
                      ...courseForm,
                      category: event.target.value || undefined,
                    })
                  }
                >
                  {(categories.data?.data ?? []).map((item) => (
                    <option key={item.id} value={item.label}>
                      {item.label}
                    </option>
                  ))}
                </Select>
                <Input
                  label="Provider"
                  value={courseForm.provider ?? ''}
                  onChange={(event) =>
                    setCourseForm({ ...courseForm, provider: event.target.value })
                  }
                />
                <Input
                  label="Certificate valid for (months)"
                  type="number"
                  min={1}
                  value={courseForm.certValidMonths ?? ''}
                  onChange={(event) =>
                    setCourseForm({
                      ...courseForm,
                      certValidMonths: event.target.value
                        ? Number(event.target.value)
                        : undefined,
                    })
                  }
                />
                <div className="md:col-span-3">
                  <Textarea
                    label="Description"
                    rows={2}
                    value={courseForm.description ?? ''}
                    onChange={(event) =>
                      setCourseForm({ ...courseForm, description: event.target.value })
                    }
                  />
                </div>
              </div>
              <div className="mt-4 flex justify-end">
                <Button
                  onClick={() => void submitCourse()}
                  isLoading={createCourse.isPending}
                  data-testid="course-form-submit"
                >
                  Save
                </Button>
              </div>
            </Card>
          )}

          <Card>
            {courses.isLoading && (
              <p className="p-6 text-sm text-text-muted">Loading the catalogue…</p>
            )}
            {!courses.isLoading && courseRows.length === 0 && (
              <EmptyState
                icon={<BookOpen className="h-6 w-6" aria-hidden />}
                title="The catalogue is empty"
                description="Add the first course, then schedule a sitting of it."
              />
            )}
            {courseRows.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <thead className="border-b border-surface-border-light text-xs uppercase tracking-wide text-text-muted">
                    <tr>
                      <th scope="col" className="px-5 py-3 text-start font-medium">Code</th>
                      <th scope="col" className="px-5 py-3 text-start font-medium">Title</th>
                      <th scope="col" className="px-5 py-3 text-start font-medium">Category</th>
                      <th scope="col" className="px-5 py-3 text-start font-medium">Provider</th>
                      <th scope="col" className="px-5 py-3 text-start font-medium">Certificate</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-surface-border-light">
                    {courseRows.map((course) => (
                      <tr key={course.id} data-testid={`course-row-${course.code}`}>
                        <td className="px-5 py-3 font-mono text-xs text-text-muted">
                          {course.code}
                        </td>
                        <td className="px-5 py-3">
                          <span className="font-medium text-text-heading">
                            {course.title}
                          </span>
                          {!course.isActive && (
                            <span className="ms-2 align-middle">
                              <Badge>Retired</Badge>
                            </span>
                          )}
                        </td>
                        <td className="px-5 py-3 text-text-muted">
                          {course.category ?? '—'}
                        </td>
                        <td className="px-5 py-3 text-text-muted">
                          {course.provider ?? '—'}
                        </td>
                        <td className="px-5 py-3 text-text-muted">
                          {course.certValidMonths
                            ? `Valid ${course.certValidMonths} months`
                            : 'Never expires'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}

      {nominateFor && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Nominate somebody for ${nominateFor.course?.title}`}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
          <Card className="w-full max-w-md p-5">
            <h2 className="text-base font-semibold text-text-heading">
              Nominate for {nominateFor.course?.title}
            </h2>
            <p className="mb-4 mt-1 text-xs text-text-muted">
              {formatDateOnly(nominateFor.startDate)} →{' '}
              {formatDateOnly(nominateFor.endDate)}
            </p>
            <div className="space-y-3">
              <Select
                label="Employee"
                placeholder="Choose an employee…"
                value={nomineeId}
                onChange={(event) => setNomineeId(event.target.value)}
                data-testid="nominate-employee"
              >
                {(people.data?.data ?? []).map((person) => (
                  <option key={person.id} value={person.id}>
                    {fullName(person)} ({person.employeeCode})
                  </option>
                ))}
              </Select>
              <Textarea
                label="Why this person needs this course"
                rows={3}
                value={justification}
                onChange={(event) => setJustification(event.target.value)}
              />
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setNominateFor(null)}>
                Cancel
              </Button>
              <Button
                onClick={() => void submitNomination()}
                isLoading={nominate.isPending}
                data-testid="nominate-submit"
              >
                Nominate
              </Button>
            </div>
          </Card>
        </div>
      )}

      {attendanceFor && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Record attendance"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
          <Card className="w-full max-w-md p-5">
            <h2 className="text-base font-semibold text-text-heading">
              Attendance for {attendanceFor.employee?.fullName}
            </h2>
            <p className="mb-4 mt-1 text-xs text-text-muted">
              {attendanceFor.session?.course?.title}. A certificate expiry is
              derived from the course validity window.
            </p>
            <div className="space-y-3">
              <Input
                label="Score"
                type="number"
                min={0}
                max={100}
                value={score}
                onChange={(event) => setScore(event.target.value)}
              />
              <label className="flex items-center gap-2 text-sm text-text-body">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded-sm border-surface-border accent-brand-primary"
                  checked={passed}
                  onChange={(event) => setPassed(event.target.checked)}
                />
                Passed
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setAttendanceFor(null)}>
                Cancel
              </Button>
              <Button
                variant="outline"
                onClick={() => void submitAttendance(false)}
                isLoading={recordAttendance.isPending}
              >
                No-show
              </Button>
              <Button
                onClick={() => void submitAttendance(true)}
                isLoading={recordAttendance.isPending}
                data-testid="attendance-submit"
              >
                Attended
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

export default function TrainingPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER', 'MANAGER']}>
      <TrainingScreen />
    </ProtectedRoute>
  );
}

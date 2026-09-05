'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  GraduationCap,
  Loader2,
  Plus,
  X,
  Check,
  UserPlus,
  CalendarDays,
  Sparkles,
  BadgeCheck,
} from 'lucide-react';
import { toast } from 'sonner';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import trainingService from '@/services/trainingService';
import MasterEmptyHint from '@/components/common/MasterEmptyHint';
import employeeService from '@/services/employeeService';
import { useAuthStore } from '@/store/authStore';
import {
  Course,
  CreateCourseData,
  CreateSessionData,
  NominationStatus,
  TrainingNomination,
  TrainingSession,
} from '@/types/training';

type Tab = 'sessions' | 'nominations' | 'courses';

const NOMINATION_STYLE: Record<NominationStatus, string> = {
  PENDING: 'bg-amber-50 text-amber-700',
  APPROVED: 'bg-emerald-50 text-emerald-700',
  REJECTED: 'bg-red-50 text-red-700',
  CANCELLED: 'bg-slate-100 text-slate-600',
  ATTENDED: 'bg-blue-50 text-blue-700',
  NO_SHOW: 'bg-orange-50 text-orange-700',
};

const inputCls =
  'w-full h-10 px-3 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/30';

function fmtDate(d?: string | null) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return String(d);
  }
}

function TrainingPageInner() {
  const { user } = useAuthStore();
  const isHr = user?.role === 'ADMIN' || user?.role === 'HR_MANAGER';

  // The one heading for this route, rendered by TopHeader.
  usePageHeader('Training', 'Course catalogue, sessions, nominations and certificates');

  const [tab, setTab] = useState<Tab>('sessions');
  const [courses, setCourses] = useState<Course[]>([]);
  const [sessions, setSessions] = useState<TrainingSession[]>([]);
  const [nominations, setNominations] = useState<TrainingNomination[]>([]);
  const [employees, setEmployees] = useState<
    { id: string; fullName: string; employeeCode: string }[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [showCourseForm, setShowCourseForm] = useState(false);
  const [courseForm, setCourseForm] = useState<CreateCourseData>({
    code: '',
    title: '',
  });

  const [showSessionForm, setShowSessionForm] = useState(false);
  const [sessionForm, setSessionForm] = useState<CreateSessionData>({
    courseId: '',
    startDate: '',
    endDate: '',
  });

  const [nominateFor, setNominateFor] = useState<TrainingSession | null>(null);
  const [nominateEmployeeId, setNominateEmployeeId] = useState('');

  const [attendanceFor, setAttendanceFor] = useState<TrainingNomination | null>(null);
  const [score, setScore] = useState('');
  const [passed, setPassed] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [c, s, n] = await Promise.all([
        trainingService.listCourses(),
        trainingService.listSessions(),
        trainingService.listNominations(),
      ]);
      setCourses(Array.isArray(c.data) ? c.data : []);
      setSessions(Array.isArray(s.data) ? s.data : []);
      setNominations(Array.isArray(n.data) ? n.data : []);
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Failed to load training data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    (async () => {
      try {
        const res = await employeeService.getDirectory();
        setEmployees(
          (res.data || []).map((e: any) => ({
            id: e.id,
            fullName: e.fullName,
            employeeCode: e.employeeCode,
          })),
        );
      } catch {
        // Non-fatal — the nominate picker is just empty.
      }
    })();
  }, []);

  const submitCourse = async () => {
    if (!courseForm.code.trim() || !courseForm.title.trim()) {
      toast.warning('Code and title are required');
      return;
    }
    setSaving(true);
    try {
      await trainingService.createCourse(courseForm);
      toast.success('Course added');
      setShowCourseForm(false);
      setCourseForm({ code: '', title: '' });
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Failed to add course');
    } finally {
      setSaving(false);
    }
  };

  const submitSession = async () => {
    if (!sessionForm.courseId || !sessionForm.startDate || !sessionForm.endDate) {
      toast.warning('Course and dates are required');
      return;
    }
    setSaving(true);
    try {
      await trainingService.createSession(sessionForm);
      toast.success('Session scheduled');
      setShowSessionForm(false);
      setSessionForm({ courseId: '', startDate: '', endDate: '' });
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Failed to schedule session');
    } finally {
      setSaving(false);
    }
  };

  const submitNominate = async () => {
    if (!nominateFor || !nominateEmployeeId) {
      toast.warning('Pick an employee');
      return;
    }
    setSaving(true);
    try {
      await trainingService.nominate({
        sessionId: nominateFor.id,
        employeeId: nominateEmployeeId,
      });
      toast.success('Nominated');
      setNominateFor(null);
      setNominateEmployeeId('');
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Failed to nominate');
    } finally {
      setSaving(false);
    }
  };

  const decide = async (n: TrainingNomination, approve: boolean) => {
    setBusyId(n.id);
    try {
      if (approve) await trainingService.approve(n.id);
      else await trainingService.reject(n.id);
      toast.success(approve ? 'Approved' : 'Rejected');
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Failed');
    } finally {
      setBusyId(null);
    }
  };

  const submitAttendance = async (attended: boolean) => {
    if (!attendanceFor) return;
    setSaving(true);
    try {
      await trainingService.recordAttendance(attendanceFor.id, {
        attended,
        score: score ? Number(score) : undefined,
        passed: attended ? passed : undefined,
      });
      toast.success(
        attended
          ? 'Attendance recorded — certificate expiry set from the course validity window'
          : 'Recorded as no-show',
      );
      setAttendanceFor(null);
      setScore('');
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Failed to record attendance');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex gap-1 rounded-xl bg-slate-100 p-1">
        {(['sessions', 'nominations', 'courses'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 rounded-lg px-3 py-1.5 text-sm font-medium capitalize transition ${
              tab === t ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white p-8 text-slate-500 shadow-sm">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading…
        </div>
      ) : (
        <>
          {/* ── Sessions ─────────────────────────────────────────────────── */}
          {tab === 'sessions' && (
            <div className="space-y-3">
              {isHr && (
                <div className="flex justify-end">
                  <button
                    onClick={() => setShowSessionForm((v) => !v)}
                    className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand-primary px-4 text-sm font-medium text-white"
                  >
                    <Plus size={16} /> Schedule session
                  </button>
                </div>
              )}

              {showSessionForm && (
                <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  {courses.filter((c) => c.isActive).length === 0 && (
                    <MasterEmptyHint
                      what="courses"
                      href="/dashboard/training"
                      linkLabel="add one on the Courses tab"
                      className="mb-3"
                    />
                  )}
                  <div className="grid gap-3 md:grid-cols-3">
                    <select
                      className={inputCls}
                      value={sessionForm.courseId}
                      onChange={(e) =>
                        setSessionForm({ ...sessionForm, courseId: e.target.value })
                      }
                      disabled={courses.filter((c) => c.isActive).length === 0}
                    >
                      <option value="">
                        {courses.filter((c) => c.isActive).length === 0
                          ? 'No courses in the catalogue'
                          : 'Course…'}
                      </option>
                      {courses
                        .filter((c) => c.isActive)
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.code} — {c.title}
                          </option>
                        ))}
                    </select>
                    <label className="flex flex-col gap-1 text-xs text-slate-500">
                      Start
                      <input
                        type="date"
                        className={inputCls}
                        value={sessionForm.startDate}
                        onChange={(e) =>
                          setSessionForm({ ...sessionForm, startDate: e.target.value })
                        }
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-slate-500">
                      End
                      <input
                        type="date"
                        className={inputCls}
                        value={sessionForm.endDate}
                        onChange={(e) =>
                          setSessionForm({ ...sessionForm, endDate: e.target.value })
                        }
                      />
                    </label>
                    <input
                      className={inputCls}
                      placeholder="Location"
                      value={sessionForm.location ?? ''}
                      onChange={(e) =>
                        setSessionForm({ ...sessionForm, location: e.target.value })
                      }
                    />
                    <input
                      className={inputCls}
                      placeholder="Trainer"
                      value={sessionForm.trainer ?? ''}
                      onChange={(e) =>
                        setSessionForm({ ...sessionForm, trainer: e.target.value })
                      }
                    />
                    <input
                      type="number"
                      min={1}
                      className={inputCls}
                      placeholder="Seats (blank = unlimited)"
                      value={sessionForm.seats ?? ''}
                      onChange={(e) =>
                        setSessionForm({
                          ...sessionForm,
                          seats: e.target.value ? Number(e.target.value) : undefined,
                        })
                      }
                    />
                  </div>
                  <div className="mt-4 flex justify-end gap-2">
                    <button
                      onClick={() => setShowSessionForm(false)}
                      className="h-10 rounded-lg border border-slate-200 px-3 text-sm text-slate-600"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={submitSession}
                      disabled={saving}
                      className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand-primary px-4 text-sm font-medium text-white disabled:opacity-50"
                    >
                      {saving && <Loader2 className="h-4 w-4 animate-spin" />} Schedule
                    </button>
                  </div>
                </div>
              )}

              {sessions.length === 0 ? (
                <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-slate-400 shadow-sm">
                  No sessions scheduled.
                </div>
              ) : (
                sessions.map((s) => (
                  <div
                    key={s.id}
                    className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <GraduationCap size={15} className="text-brand-primary" />
                          <p className="text-sm font-semibold text-slate-800">
                            {s.course?.title}
                          </p>
                          <span className="font-mono text-xs text-slate-400">
                            {s.course?.code}
                          </span>
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
                            {s.status}
                          </span>
                        </div>
                        <p className="mt-1 flex flex-wrap items-center gap-3 text-xs text-slate-500">
                          <span className="inline-flex items-center gap-1">
                            <CalendarDays size={11} /> {fmtDate(s.startDate)} →{' '}
                            {fmtDate(s.endDate)}
                          </span>
                          {s.location && <span>{s.location}</span>}
                          {s.trainer && <span>Trainer: {s.trainer}</span>}
                          <span>
                            {s._count?.nominations ?? 0}
                            {s.seats ? ` / ${s.seats}` : ''} seat(s) taken
                          </span>
                          {s.course?.certValidMonths && (
                            <span className="inline-flex items-center gap-1 text-emerald-700">
                              <BadgeCheck size={11} /> Certificate valid{' '}
                              {s.course.certValidMonths} months
                            </span>
                          )}
                        </p>
                      </div>
                      {isHr && s.status === 'SCHEDULED' && (
                        <button
                          onClick={() => setNominateFor(s)}
                          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
                        >
                          <UserPlus size={14} /> Nominate
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {/* ── Nominations ──────────────────────────────────────────────── */}
          {tab === 'nominations' && (
            <div className="space-y-3">
              {nominations.length === 0 ? (
                <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-slate-400 shadow-sm">
                  No nominations.
                </div>
              ) : (
                nominations.map((n) => (
                  <div
                    key={n.id}
                    className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-semibold text-slate-800">
                            {n.employee?.fullName}
                          </p>
                          <span className="text-xs text-slate-400">
                            {n.employee?.employeeCode}
                          </span>
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-medium ${NOMINATION_STYLE[n.status]}`}
                          >
                            {n.status.replace('_', ' ')}
                          </span>
                          {n.source === 'APPRAISAL' && (
                            <span
                              className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-[11px] text-violet-700"
                              title="Derived from an AI appraisal result"
                            >
                              <Sparkles size={10} /> From appraisal
                            </span>
                          )}
                        </div>
                        <p className="mt-1 text-sm text-slate-700">
                          {n.session?.course?.title}
                        </p>
                        <p className="mt-0.5 text-xs text-slate-500">
                          {fmtDate(n.session?.startDate)} · cost{' '}
                          {n.cost !== null && n.cost !== undefined
                            ? Number(n.cost).toLocaleString()
                            : '—'}
                          {n.score !== null && n.score !== undefined
                            ? ` · score ${n.score}`
                            : ''}
                          {n.certificateExpiry
                            ? ` · certificate expires ${fmtDate(n.certificateExpiry)}`
                            : ''}
                        </p>
                        {n.justification && (
                          <p className="mt-1 text-xs italic text-slate-500">
                            “{n.justification}”
                          </p>
                        )}
                      </div>

                      <div className="flex items-center gap-2">
                        {n.status === 'PENDING' && isHr && (
                          <>
                            <button
                              onClick={() => decide(n, true)}
                              disabled={busyId === n.id}
                              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-sm font-medium text-white disabled:opacity-50"
                            >
                              <Check size={14} /> Approve
                            </button>
                            <button
                              onClick={() => decide(n, false)}
                              disabled={busyId === n.id}
                              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-red-200 px-3 text-sm font-medium text-red-600 disabled:opacity-50"
                            >
                              <X size={14} /> Reject
                            </button>
                          </>
                        )}
                        {n.status === 'APPROVED' && isHr && (
                          <button
                            onClick={() => setAttendanceFor(n)}
                            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
                          >
                            <BadgeCheck size={14} /> Record attendance
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {/* ── Courses ──────────────────────────────────────────────────── */}
          {tab === 'courses' && (
            <div className="space-y-3">
              {isHr && (
                <div className="flex justify-end">
                  <button
                    onClick={() => setShowCourseForm((v) => !v)}
                    className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand-primary px-4 text-sm font-medium text-white"
                  >
                    <Plus size={16} /> Add course
                  </button>
                </div>
              )}

              {showCourseForm && (
                <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  <div className="grid gap-3 md:grid-cols-3">
                    <input
                      className={inputCls}
                      placeholder="Code (e.g. SEC-101)"
                      value={courseForm.code}
                      onChange={(e) =>
                        setCourseForm({ ...courseForm, code: e.target.value })
                      }
                    />
                    <input
                      className={`${inputCls} md:col-span-2`}
                      placeholder="Title"
                      value={courseForm.title}
                      onChange={(e) =>
                        setCourseForm({ ...courseForm, title: e.target.value })
                      }
                    />
                    <input
                      className={inputCls}
                      placeholder="Provider"
                      value={courseForm.provider ?? ''}
                      onChange={(e) =>
                        setCourseForm({ ...courseForm, provider: e.target.value })
                      }
                    />
                    <input
                      type="number"
                      min={0}
                      className={inputCls}
                      placeholder="Default cost"
                      value={courseForm.defaultCost ?? ''}
                      onChange={(e) =>
                        setCourseForm({
                          ...courseForm,
                          defaultCost: e.target.value
                            ? Number(e.target.value)
                            : undefined,
                        })
                      }
                    />
                    <label className="flex flex-col gap-1 text-xs text-slate-500">
                      Certificate valid (months) — drives expiry reminders
                      <input
                        type="number"
                        min={1}
                        className={inputCls}
                        value={courseForm.certValidMonths ?? ''}
                        onChange={(e) =>
                          setCourseForm({
                            ...courseForm,
                            certValidMonths: e.target.value
                              ? Number(e.target.value)
                              : undefined,
                          })
                        }
                      />
                    </label>
                    <textarea
                      className="md:col-span-3 rounded-lg border border-slate-200 px-3 py-2 text-sm"
                      rows={2}
                      placeholder="Description — used when matching appraisal development areas to courses"
                      value={courseForm.description ?? ''}
                      onChange={(e) =>
                        setCourseForm({ ...courseForm, description: e.target.value })
                      }
                    />
                  </div>
                  <div className="mt-4 flex justify-end gap-2">
                    <button
                      onClick={() => setShowCourseForm(false)}
                      className="h-10 rounded-lg border border-slate-200 px-3 text-sm text-slate-600"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={submitCourse}
                      disabled={saving}
                      className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand-primary px-4 text-sm font-medium text-white disabled:opacity-50"
                    >
                      {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save
                    </button>
                  </div>
                </div>
              )}

              <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                    <tr>
                      <th className="px-4 py-3">Code</th>
                      <th className="px-4 py-3">Title</th>
                      <th className="px-4 py-3">Provider</th>
                      <th className="px-4 py-3">Default cost</th>
                      <th className="px-4 py-3">Certificate validity</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {courses.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-4 py-10 text-center text-slate-400">
                          No courses in the catalogue.
                        </td>
                      </tr>
                    ) : (
                      courses.map((c) => (
                        <tr key={c.id}>
                          <td className="px-4 py-3 font-mono text-xs text-slate-600">
                            {c.code}
                          </td>
                          <td className="px-4 py-3 text-slate-800">{c.title}</td>
                          <td className="px-4 py-3 text-slate-600">
                            {c.provider || '—'}
                          </td>
                          <td className="px-4 py-3 text-slate-600">
                            {c.defaultCost
                              ? Number(c.defaultCost).toLocaleString()
                              : '—'}
                          </td>
                          <td className="px-4 py-3 text-slate-600">
                            {c.certValidMonths
                              ? `${c.certValidMonths} months`
                              : 'Never expires'}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* Nominate */}
      {nominateFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
            <h3 className="mb-1 text-base font-semibold text-slate-900">
              Nominate for {nominateFor.course?.title}
            </h3>
            <p className="mb-4 text-xs text-slate-500">
              {fmtDate(nominateFor.startDate)} ·{' '}
              {nominateFor.seats
                ? `${nominateFor._count?.nominations ?? 0} of ${nominateFor.seats} seats taken`
                : 'unlimited seats'}
            </p>
            <select
              className={inputCls}
              value={nominateEmployeeId}
              onChange={(e) => setNominateEmployeeId(e.target.value)}
            >
              <option value="">Select employee…</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.fullName} ({e.employeeCode})
                </option>
              ))}
            </select>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setNominateFor(null)}
                className="h-9 rounded-lg border border-slate-200 px-3 text-sm text-slate-600"
              >
                Cancel
              </button>
              <button
                onClick={submitNominate}
                disabled={saving}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand-primary px-3 text-sm font-medium text-white disabled:opacity-50"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />} Nominate
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Attendance */}
      {attendanceFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
            <h3 className="mb-1 text-base font-semibold text-slate-900">
              Record attendance
            </h3>
            <p className="mb-4 text-xs text-slate-500">
              {attendanceFor.employee?.fullName} —{' '}
              {attendanceFor.session?.course?.title}.
              {attendanceFor.session?.course?.certValidMonths
                ? ` The certificate will expire ${attendanceFor.session.course.certValidMonths} months after the session ends.`
                : ''}
            </p>
            <div className="space-y-3">
              <label className="flex flex-col gap-1 text-xs text-slate-500">
                Score (optional)
                <input
                  type="number"
                  min={0}
                  max={100}
                  className={inputCls}
                  value={score}
                  onChange={(e) => setScore(e.target.value)}
                />
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={passed}
                  onChange={(e) => setPassed(e.target.checked)}
                />
                Passed
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setAttendanceFor(null)}
                className="h-9 rounded-lg border border-slate-200 px-3 text-sm text-slate-600"
              >
                Cancel
              </button>
              <button
                onClick={() => submitAttendance(false)}
                disabled={saving}
                className="h-9 rounded-lg border border-orange-200 px-3 text-sm font-medium text-orange-700 disabled:opacity-50"
              >
                No-show
              </button>
              <button
                onClick={() => submitAttendance(true)}
                disabled={saving}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand-primary px-3 text-sm font-medium text-white disabled:opacity-50"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />} Attended
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function TrainingPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER', 'MANAGER']}>
      <TrainingPageInner />
    </ProtectedRoute>
  );
}

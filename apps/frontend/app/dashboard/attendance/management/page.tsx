'use client';

import { useMemo, useState } from 'react';
import { DateTime } from 'luxon';
import { toast } from 'sonner';
import { CheckCircle2, Search, Users, XCircle } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useBulkAttendance } from '@/hooks/useAttendance';
import { useAuthStore } from '@/store/authStore';
import { useBranches } from '@/hooks/useBranches';
import { useDebounce } from '@/hooks/useDebounce';
import { useDepartments } from '@/hooks/useDepartments';
import { useEmployees } from '@/hooks/useEmployees';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { EmptyState } from '@/components/common/EmptyState';
import { apiErrorMessage } from '@/utils/apiError';
import { fullName } from '@/utils/formatters';
import type {
  BulkAttendanceEntry,
  BulkAttendanceResult,
  NonPunchStatus,
} from '@/types/attendance';

/**
 * The only verdicts this screen may assert.
 *
 * PRESENT, LATE and HALF_DAY are derived by the server from the times on the
 * row; sending one would overwrite a calculation payroll later reads, and the
 * endpoint refuses them. What a human knows and the clock does not is exactly
 * this list.
 */
const MARKS: Array<{ value: NonPunchStatus; label: string }> = [
  { value: 'ABSENT', label: 'Absent' },
  { value: 'ON_LEAVE', label: 'On leave' },
  { value: 'HOLIDAY', label: 'Holiday' },
  { value: 'WEEKEND', label: 'Weekend' },
];

/** One outcome per person, named. */
interface Outcome {
  employeeId: string;
  name: string;
  outcome: 'created' | 'updated' | 'failed';
  message?: string;
}

function AttendanceManager() {
  // Reading the roster is a management view; WRITING a verdict onto somebody
  // else's timesheet is not, and the endpoint agrees. A payroll officer or a
  // department head sees the grid and cannot save from it.
  const role = useAuthStore((s) => s.user?.role);
  const canMark = role === 'ADMIN' || role === 'HR_MANAGER';

  const [date, setDate] = useState(() => DateTime.now().toISODate() ?? '');
  const [departmentId, setDepartmentId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [search, setSearch] = useState('');
  const [notes, setNotes] = useState('');
  const [marks, setMarks] = useState<Record<string, NonPunchStatus | ''>>({});
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null);

  const debouncedSearch = useDebounce(search, 300);
  const departments = useDepartments();
  const branches = useBranches();
  const bulk = useBulkAttendance();

  const { data, isLoading, isError } = useEmployees({
    limit: 200,
    status: 'ACTIVE',
    search: debouncedSearch || undefined,
    departmentId: departmentId || undefined,
    branchId: branchId || undefined,
    sortBy: 'firstName',
    sortOrder: 'asc',
  });

  const employees = useMemo(() => data?.data ?? [], [data]);
  const marked = useMemo(
    () => employees.filter((employee) => marks[employee.id]),
    [employees, marks],
  );

  usePageHeader('Attendance manager', 'Mark a day for a set of people at once.');

  const setAll = (status: NonPunchStatus | '') => {
    setMarks((current) => {
      const next = { ...current };
      for (const employee of employees) {
        if (status) next[employee.id] = status;
        else delete next[employee.id];
      }
      return next;
    });
  };

  /**
   * Submit, grouped by verdict.
   *
   * The endpoint marks one status across a set of people, so a grid where each
   * row can differ becomes one call per distinct verdict — at most four. The
   * per-row results are merged back together, because what the reader needs is
   * a single list of who was marked and who was not.
   */
  const submit = async () => {
    if (!date || marked.length === 0) return;

    const nameOf = (id: string) => {
      const match = employees.find((employee) => employee.id === id);
      return match ? fullName(match) : id;
    };

    // One request for the whole grid: the verdict rides on each entry, so a
    // morning of absences and one half-day go up together and come back as one
    // set of per-row outcomes to reconcile rather than several.
    const entries: BulkAttendanceEntry[] = marked.map((employee) => ({
      employeeId: employee.id,
      status: marks[employee.id] as NonPunchStatus,
      notes: notes.trim() || undefined,
    }));

    const collected: Outcome[] = [];
    try {
      const response = await bulk.mutateAsync({ date, entries });
      const result = response.data as BulkAttendanceResult;
      for (const row of result.results) {
        collected.push({
          employeeId: row.employeeId,
          name: nameOf(row.employeeId),
          outcome: row.outcome,
          message: row.message,
        });
      }
    } catch (error) {
      // A whole call failed — a bad date, a lost connection. That is different
      // from a row the server rejected, and it gets its own message.
      toast.error(apiErrorMessage(error));
      return;
    }

    setOutcomes(collected);

    const failed = collected.filter((row) => row.outcome === 'failed');
    const applied = collected.length - failed.length;

    // One bad row must not read as a failed batch: the count that succeeded is
    // reported either way, and the failures are named below rather than folded
    // into a single "something went wrong".
    if (failed.length === 0) {
      toast.success(`Marked ${applied} ${applied === 1 ? 'person' : 'people'}`);
      setMarks({});
    } else {
      toast.warning(
        `Marked ${applied}; ${failed.length} could not be marked — see the list below`,
      );
    }
  };

  return (
    <div className="space-y-5">
      {!canMark && (
        <p className="rounded-[var(--radius-card)] border border-status-info/30 bg-status-info-bg px-4 py-3 text-sm font-medium text-status-info">
          Read-only for your role — marking a day is left to HR and administrators.
        </p>
      )}

      <Card className="p-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {/* A date-only value, kept as `YYYY-MM-DD` all the way to the API: the
              day work is attributed to has no time of day to convert. */}
          <Input label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <Select
            label="Department"
            placeholder="Every department"
            value={departmentId}
            onChange={(e) => setDepartmentId(e.target.value)}
          >
            {(departments.data?.data ?? []).map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
          </Select>
          <Select
            label="Branch"
            placeholder="Every branch"
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
          >
            {(branches.data?.data ?? []).map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name}
              </option>
            ))}
          </Select>
          <Input
            label="Person"
            placeholder="Name or code"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            icon={<Search className="h-4 w-4" aria-hidden />}
          />
        </div>

        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <Select
            label="Mark everyone listed as"
            // Snaps back to the placeholder after each use: this is an action,
            // not a field, and leaving the last verdict showing would suggest
            // the rows below still agree with it after one has been changed.
            placeholder="Clear every row"
            value=""
            onChange={(e) => setAll(e.target.value as NonPunchStatus | '')}
          >
            {MARKS.map((mark) => (
              <option key={mark.value} value={mark.value}>
                {mark.label}
              </option>
            ))}
          </Select>
          <Textarea
            label="Note"
            rows={2}
            placeholder="Recorded against every row in this batch"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
      </Card>

      {outcomes && outcomes.some((row) => row.outcome === 'failed') && (
        <Card className="p-5">
          <h3 className="text-base font-semibold text-text-heading">
            {outcomes.filter((row) => row.outcome === 'failed').length} could not be marked
          </h3>
          <p className="mt-0.5 text-sm text-text-muted">
            The rest of the batch was written. Each of these was refused on its own.
          </p>
          <ul className="mt-3 space-y-2">
            {outcomes
              .filter((row) => row.outcome === 'failed')
              .map((row) => (
                <li
                  key={row.employeeId}
                  className="flex items-start gap-2 rounded-[var(--radius-card)] border border-status-error/30 bg-status-error-bg px-3 py-2 text-sm text-status-error"
                >
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <span>
                    <span className="font-semibold">{row.name}</span>
                    {row.message ? ` — ${row.message}` : ''}
                  </span>
                </li>
              ))}
          </ul>
        </Card>
      )}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-surface-border-light px-5 py-4">
          <div>
            <h3 className="text-base font-semibold text-text-heading">Who to mark</h3>
            <p className="mt-0.5 text-sm text-text-muted">
              {marked.length} of {employees.length} listed
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => setMarks({})} disabled={marked.length === 0}>
              Clear
            </Button>
            <Button
              onClick={() => void submit()}
              isLoading={bulk.isPending}
              disabled={!canMark || !date || marked.length === 0}
            >
              Save {marked.length || ''}
            </Button>
          </div>
        </div>

        {isLoading && <p className="p-6 text-sm text-text-muted">Loading people…</p>}

        {isError && (
          <p className="p-6 text-sm text-status-error">
            Could not load the employee list. Is the API running?
          </p>
        )}

        {!isLoading && !isError && employees.length === 0 && (
          <EmptyState
            icon={<Users className="h-6 w-6" aria-hidden />}
            title="Nobody matches"
            description="Widen the search, or clear the department and branch filters."
          />
        )}

        {employees.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="border-b border-surface-border-light text-xs uppercase tracking-wide text-text-muted">
                <tr>
                  <th className="px-5 py-3 text-start font-medium">Employee</th>
                  <th className="px-5 py-3 text-start font-medium">Department</th>
                  <th className="px-5 py-3 text-start font-medium">Branch</th>
                  <th className="px-5 py-3 text-start font-medium">Mark as</th>
                  <th className="px-5 py-3 text-start font-medium">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border-light">
                {employees.map((employee) => {
                  const outcome = outcomes?.find((row) => row.employeeId === employee.id);
                  return (
                    <tr key={employee.id} className="hover:bg-surface-border-light/60">
                      <td className="px-5 py-3">
                        <p className="font-medium text-text-heading">{fullName(employee)}</p>
                        <p className="text-xs text-text-muted">{employee.employeeCode}</p>
                      </td>
                      <td className="px-5 py-3 text-text-body">
                        {employee.department?.name ?? '—'}
                      </td>
                      <td className="px-5 py-3 text-text-body">{employee.branch?.name ?? '—'}</td>
                      <td className="px-5 py-3">
                        <div className="w-44">
                          <Select
                            aria-label={`Mark ${fullName(employee)} as`}
                            placeholder="Leave alone"
                            value={marks[employee.id] ?? ''}
                            onChange={(event) =>
                              setMarks((current) => ({
                                ...current,
                                [employee.id]: event.target.value as NonPunchStatus | '',
                              }))
                            }
                          >
                            {MARKS.map((mark) => (
                              <option key={mark.value} value={mark.value}>
                                {mark.label}
                              </option>
                            ))}
                          </Select>
                        </div>
                      </td>
                      <td className="px-5 py-3">
                        {outcome?.outcome === 'failed' && (
                          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-status-error">
                            <XCircle className="h-3.5 w-3.5" aria-hidden />
                            {outcome.message ?? 'Refused'}
                          </span>
                        )}
                        {outcome && outcome.outcome !== 'failed' && (
                          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-status-success">
                            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                            {outcome.outcome === 'created' ? 'Created' : 'Updated'}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

export default function AttendanceManagementPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER', 'PAYROLL_OFFICER', 'MANAGER']}>
      <AttendanceManager />
    </ProtectedRoute>
  );
}

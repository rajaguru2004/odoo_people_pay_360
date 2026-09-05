'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  CalendarDays,
  CalendarX2,
  Plus,
  Search,
  Users,
} from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import BulkScheduleModal from '@/components/schedules/BulkScheduleModal';
import EmployeeChip from '@/components/schedules/EmployeeChip';
import ScheduleLegend from '@/components/schedules/ScheduleLegend';
import ScheduleModal from '@/components/schedules/ScheduleModal';
import { SHIFT_PALETTE } from '@/components/schedules/shiftStyles';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useBranches } from '@/hooks/useBranches';
import { useEmployees } from '@/hooks/useEmployees';
import { usePageHeader } from '@/hooks/usePageHeader';
import {
  useDeleteSchedule,
  useScheduleCoverage,
  useWorkScheduleRows,
} from '@/hooks/useSchedules';
import { apiErrorMessage } from '@/utils/apiError';
import { formatDateOnly } from '@/utils/formatDate';
import {
  SHIFT_ORDER,
  monthBounds,
  roundHours,
  shiftHours,
  shiftWindowLabel,
  todayKey,
  weekBounds,
} from '@/utils/scheduleHours';
import type { ShiftType, WorkSchedule } from '@/types/attendance';

/** The windows the list offers, and the bounds each one resolves to. */
const RANGES = ['week', 'month'] as const;
type RangeKey = (typeof RANGES)[number];

/**
 * Shift management: the roster as rows, and the three ways to change it.
 *
 * The calendar screen beside this one is for reading one person's month. This is
 * for WORKING the roster — filter to a branch and a shift type, see what is
 * there, add one, edit one, remove one, or lay a pattern over a fortnight.
 *
 * The coverage strip at the top is not decoration. Every write on this page
 * moves it, and it is the only place a scheduler finds out that the shift they
 * just added landed on a public holiday.
 */
function ShiftManagement() {
  const t = useTranslations('schedules');
  usePageHeader(t('shiftsTitle'), t('shiftsSubtitle'));

  const [rangeKey, setRangeKey] = useState<RangeKey>('week');
  const [anchor] = useState(todayKey());
  const [search, setSearch] = useState('');
  const [branchId, setBranchId] = useState('');
  const [shiftType, setShiftType] = useState<ShiftType | ''>('');

  const [modalOpen, setModalOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [editing, setEditing] = useState<WorkSchedule | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { start, end } = useMemo(
    () => (rangeKey === 'week' ? weekBounds(anchor) : monthBounds(anchor)),
    [rangeKey, anchor],
  );

  const rows = useWorkScheduleRows({
    startDate: start,
    endDate: end,
    branchId: branchId || undefined,
    shiftType: shiftType || undefined,
    limit: 200,
  });
  const coverage = useScheduleCoverage({ startDate: start, endDate: end });
  const employees = useEmployees({ status: 'ACTIVE', limit: 200 });
  const branches = useBranches();
  const remove = useDeleteSchedule();

  const roster = useMemo(
    () =>
      (employees.data?.data ?? []).map((employee) => ({
        id: employee.id,
        employeeCode: employee.employeeCode,
        fullName: `${employee.firstName} ${employee.lastName}`,
      })),
    [employees.data],
  );

  /**
   * Name search runs over the rows already on screen.
   *
   * Branch and shift type narrow the QUERY because they change which rows the
   * server has to read; a name is a filter over an answer the browser already
   * has, and round-tripping it would put a spinner between every keystroke.
   */
  const shifts = useMemo(() => {
    const all = rows.data?.data ?? [];
    const needle = search.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((row) => {
      const name = row.employee
        ? `${row.employee.firstName} ${row.employee.lastName}`.toLowerCase()
        : '';
      return (
        name.includes(needle) ||
        (row.employee?.employeeCode ?? '').toLowerCase().includes(needle)
      );
    });
  }, [rows.data, search]);

  const summary = coverage.data;

  const listError = rows.isError ? apiErrorMessage(rows.error, t('loadFailed')) : null;
  const error = actionError ?? listError;

  const handleDelete = async (row: WorkSchedule) => {
    if (!window.confirm(t('confirmDelete'))) return;
    setActionError(null);
    setDeletingId(row.id);
    try {
      await remove.mutateAsync(row.id);
    } catch (err) {
      setActionError(apiErrorMessage(err, t('deleteFailed')));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          variant="secondary"
          onClick={() => setBulkOpen(true)}
          data-testid="shift-bulk-create"
        >
          <Users size={18} aria-hidden />
          {t('bulkCreate')}
        </Button>
        <Button
          onClick={() => {
            setEditing(null);
            setModalOpen(true);
          }}
          data-testid="shift-create"
          disabled={!roster.length}
        >
          <Plus size={18} aria-hidden />
          {t('addShift')}
        </Button>
      </div>

      {error && (
        <p
          role="alert"
          data-testid="shift-error"
          className="rounded-[var(--radius-card)] border border-status-error/30 bg-status-error-bg/40 px-4 py-3 text-sm font-medium text-status-error"
        >
          {error}
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {[
          {
            key: 'shifts',
            icon: CalendarDays,
            label: t('statShifts'),
            value: summary ? String(summary.shifts) : '—',
            tone: 'var(--color-brand-primary)',
            testId: 'shift-stat-shifts',
          },
          {
            key: 'unassigned',
            icon: CalendarX2,
            label: t('kpiUnassigned'),
            value: summary ? String(summary.unscheduled) : '—',
            tone: 'var(--color-status-warning)',
            testId: 'shift-stat-unassigned',
          },
          {
            key: 'conflicts',
            icon: AlertTriangle,
            label: t('kpiConflicts'),
            value: summary ? String(summary.conflicts.total) : '—',
            tone: 'var(--color-status-error)',
            testId: 'shift-stat-conflicts',
          },
        ].map((tile) => (
          <div
            key={tile.key}
            className="flex items-center gap-3.5 rounded-[var(--radius-card)] border border-surface-border bg-surface-card p-4"
          >
            <span
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-button)] text-white"
              style={{ background: tile.tone }}
            >
              <tile.icon size={20} aria-hidden />
            </span>
            <span className="min-w-0">
              <span className="block text-xs font-bold tracking-wide text-text-muted uppercase">
                {tile.label}
              </span>
              <span
                data-testid={tile.testId}
                className="mt-0.5 block text-xl font-extrabold text-text-heading tabular-nums"
              >
                {tile.value}
              </span>
            </span>
          </div>
        ))}
      </div>

      {/* The conflicts behind the third tile, named. A count on its own tells a
          scheduler that something is wrong and not which day to open. */}
      {summary && summary.conflicts.samples.length > 0 && (
        <ul
          data-testid="shift-conflict-list"
          className="divide-y divide-surface-border overflow-hidden rounded-[var(--radius-card)] border border-status-error/30"
        >
          {summary.conflicts.samples.slice(0, 6).map((sample, i) => (
            <li
              key={`${sample.employeeId}-${sample.date}-${i}`}
              className="flex items-center justify-between gap-3 bg-status-error-bg/20 px-4 py-2.5 text-sm"
            >
              <span className="truncate font-semibold text-text-heading">
                {sample.fullName}
              </span>
              <span className="shrink-0 text-[12px] font-medium text-text-muted">
                {formatDateOnly(sample.date)} — {sample.reason}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="rounded-[var(--radius-card)] border border-surface-border bg-surface-card p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1">
            <Input
              placeholder={t('searchStaff')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              icon={<Search size={16} aria-hidden />}
              data-testid="shift-search"
              aria-label={t('searchStaff')}
            />
          </div>
          <div className="min-w-[160px]">
            <Select
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
              data-testid="shift-branch-filter"
              aria-label={t('allBranches')}
            >
              <option value="">{t('allBranches')}</option>
              {(branches.data?.data ?? []).map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="min-w-[160px]">
            <Select
              value={shiftType}
              onChange={(e) => setShiftType(e.target.value as ShiftType | '')}
              data-testid="shift-type-filter"
              aria-label={t('allShiftTypes')}
            >
              <option value="">{t('allShiftTypes')}</option>
              {SHIFT_ORDER.map((type) => (
                <option key={type} value={type}>
                  {t(`shift.${type}`)}
                </option>
              ))}
            </Select>
          </div>
          <div className="min-w-[140px]">
            <Select
              value={rangeKey}
              onChange={(e) => setRangeKey(e.target.value as RangeKey)}
              data-testid="shift-range-filter"
              aria-label={t('thisWeek')}
            >
              <option value="week">{t('thisWeek')}</option>
              <option value="month">{t('thisMonth')}</option>
            </Select>
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-[var(--radius-card)] border border-surface-border bg-surface-card">
        <div className="flex items-center justify-between border-b border-surface-border px-5 py-3.5">
          <h2 className="text-sm font-bold text-text-heading">{t('shiftsInView')}</h2>
          <span
            data-testid="shift-count"
            className="text-sm font-semibold text-text-muted tabular-nums"
          >
            {shifts.length}
          </span>
        </div>

        {rows.isLoading ? (
          <div
            data-testid="shift-loading"
            className="flex h-64 items-center justify-center"
          >
            <span className="h-8 w-8 animate-spin rounded-full border-4 border-brand-primary border-t-transparent" />
          </div>
        ) : shifts.length === 0 ? (
          <p
            data-testid="shift-list-empty"
            className="px-5 py-16 text-center text-sm text-text-muted"
          >
            {t('noShiftsInView')}
          </p>
        ) : (
          <ul className="divide-y divide-surface-border">
            {shifts.map((row) => {
              const hours = shiftHours(row);
              const palette = SHIFT_PALETTE[row.shiftType];
              return (
                <li
                  key={row.id}
                  data-testid={`shift-row-${row.id}`}
                  data-shift-type={row.shiftType}
                  className="flex flex-wrap items-center gap-3 px-5 py-3"
                >
                  <div className="min-w-[200px] flex-1">
                    <EmployeeChip
                      name={
                        row.employee
                          ? `${row.employee.firstName} ${row.employee.lastName}`
                          : '—'
                      }
                      code={row.employee?.employeeCode}
                      avatarUrl={row.employee?.avatarUrl}
                      size="sm"
                    />
                  </div>

                  <span className="w-28 text-sm font-medium text-text-body tabular-nums">
                    {formatDateOnly(row.date)}
                  </span>

                  <span
                    className="rounded-[var(--radius-button)] border px-2.5 py-1 text-[11px] font-bold"
                    style={{
                      background: palette.background,
                      borderColor: palette.border,
                      color: palette.text,
                    }}
                  >
                    {t(`shift.${row.shiftType}`)}
                  </span>

                  <span className="min-w-[150px] text-[13px] text-text-muted">
                    {shiftWindowLabel({ ...row, hours })}
                  </span>

                  <span className="w-14 text-end text-sm font-semibold text-text-heading tabular-nums">
                    {row.isWorkDay ? `${roundHours(hours)}h` : '—'}
                  </span>

                  <span className="ms-auto flex shrink-0 items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setEditing(row);
                        setModalOpen(true);
                      }}
                      data-testid={`shift-edit-${row.id}`}
                    >
                      {t('edit')}
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      isLoading={deletingId === row.id}
                      onClick={() => handleDelete(row)}
                      data-testid={`shift-delete-${row.id}`}
                    >
                      {deletingId === row.id ? t('deleting') : t('delete')}
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <ScheduleLegend showShiftTypes />

      <ScheduleModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        schedule={editing}
        employeeId={editing?.employeeId ?? roster[0]?.id}
        employeeName={
          editing?.employee
            ? `${editing.employee.firstName} ${editing.employee.lastName}`
            : roster[0]?.fullName
        }
        date={editing?.date ?? todayKey()}
      />

      <BulkScheduleModal
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        employees={roster}
      />
    </div>
  );
}

export default function ShiftManagementPage() {
  return (
    // Writing the roster is ADMIN and HR only, exactly as every /work-schedules
    // route is server-side. A department head reads the roster on the other two
    // screens; drawing this one for them would be a page of buttons that 403.
    <ProtectedRoute
      requiredRoles={['ADMIN', 'HR_MANAGER']}
      requiredPermission="MANAGE_SCHEDULES"
    >
      <ShiftManagement />
    </ProtectedRoute>
  );
}

'use client';

import { useMemo, useState } from 'react';
import { DateTime } from 'luxon';
import { toast } from 'sonner';
import { BarChart3, Download } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useAttendanceSummary } from '@/hooks/useAttendance';
import { useBranches } from '@/hooks/useBranches';
import { useDepartments } from '@/hooks/useDepartments';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { EmptyState } from '@/components/common/EmptyState';
import { StatCard } from '@/components/common/StatCard';
import {
  BarOverviewChart,
  PanelHeader,
  type BarOverviewItem,
} from '@/components/module-landing/primitives';
import { chartAxis, formatHours, formatRate } from '@/components/attendance/attendanceFormat';
import { formatDateOnly } from '@/utils/formatDate';
import { apiErrorMessage } from '@/utils/apiError';

/** A day key in the reader's own calendar — a report range has no time of day. */
function dayKey(offsetDays = 0): string {
  return DateTime.now().plus({ days: offsetDays }).toISODate() ?? '';
}

function AttendanceReports() {
  const [from, setFrom] = useState(() => dayKey(-29));
  const [to, setTo] = useState(() => dayKey());
  const [departmentId, setDepartmentId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [exporting, setExporting] = useState(false);

  const departments = useDepartments();
  const branches = useBranches();

  const { data, isLoading, isError } = useAttendanceSummary({
    startDate: from,
    endDate: to,
    departmentId: departmentId || undefined,
    branchId: branchId || undefined,
  });

  const summary = data?.data;
  const totals = summary?.totals;

  usePageHeader(
    'Attendance reports',
    summary ? `${formatDateOnly(from)} – ${formatDateOnly(to)}` : undefined,
  );

  /** One bar per day, split into what the day was made of. */
  const { items, axis } = useMemo(() => {
    const daily = summary?.daily ?? [];
    const rows: BarOverviewItem[] = daily.map((day) => ({
      key: day.date,
      label: formatDateOnly(day.date, 'dd LLL'),
      value: day.present + day.late + day.absent + day.onLeave,
      segments: [
        {
          key: 'present',
          label: 'Present',
          value: day.present,
          color: 'color-mix(in srgb, var(--color-brand-primary) 90%, white)',
        },
        { key: 'late', label: 'Late', value: day.late, color: 'var(--color-status-warning)' },
        { key: 'absent', label: 'Absent', value: day.absent, color: 'var(--color-status-error)' },
        { key: 'onLeave', label: 'On leave', value: day.onLeave, color: 'var(--color-status-info)' },
      ],
      tooltipTitle: formatDateOnly(day.date),
      tooltipRows: [
        { label: 'Present', value: day.present },
        { label: 'Late', value: day.late },
        { label: 'Absent', value: day.absent },
        { label: 'On leave', value: day.onLeave },
        // Never coerced to a number: `null` means nothing was recorded that day,
        // and 0% would report a total no-show.
        { label: 'Attendance', value: formatRate(day.attendanceRate), emphasis: true },
      ],
    }));

    return { items: rows, axis: chartAxis(Math.max(1, ...rows.map((r) => r.value))) };
  }, [summary]);

  const exportBook = async (format: 'csv' | 'xlsx') => {
    if (!summary) return;
    setExporting(true);
    try {
      // Loaded on demand: the spreadsheet writer is far larger than this screen,
      // and most visits never press the button.
      const XLSX = await import('xlsx');

      const daily = summary.daily.map((day) => ({
        Date: day.date,
        Present: day.present,
        Late: day.late,
        'Half day': day.halfDay,
        Absent: day.absent,
        'On leave': day.onLeave,
        Holiday: day.holiday,
        Weekend: day.weekend,
        'Work hours': day.workHours,
        // Blank, not zero: a spreadsheet cell of 0 is a figure somebody will
        // later average, and this one was never measured.
        'Attendance %': day.attendanceRate ?? '',
      }));

      const byDepartment = summary.departments.map((department) => ({
        Department: department.name,
        Headcount: department.headcount,
        Present: department.present,
        Late: department.late,
        Absent: department.absent,
        'On leave': department.onLeave,
        'Work hours': department.workHours,
        'Attendance %': department.attendanceRate ?? '',
      }));

      const stem = `attendance-${summary.range.startDate}-to-${summary.range.endDate}`;

      if (format === 'csv') {
        const csv = XLSX.utils.sheet_to_csv(XLSX.utils.json_to_sheet(daily));
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `${stem}.csv`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
      } else {
        const book = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(daily), 'By day');
        XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(byDepartment), 'By department');
        XLSX.writeFile(book, `${stem}.xlsx`);
      }
    } catch (error) {
      toast.error(apiErrorMessage(error, 'The export could not be written'));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-5">
      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-40">
            <Input label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="w-40">
            <Input label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="w-52">
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
          </div>
          <div className="w-52">
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
          </div>

          <div className="ms-auto flex items-center gap-2">
            <Button
              variant="outline"
              disabled={!summary || exporting}
              onClick={() => void exportBook('csv')}
            >
              <Download className="h-4 w-4" aria-hidden />
              Export CSV
            </Button>
            <Button disabled={!summary || exporting} onClick={() => void exportBook('xlsx')}>
              <Download className="h-4 w-4" aria-hidden />
              Export XLSX
            </Button>
          </div>
        </div>
      </Card>

      {isError && (
        <Card className="p-6 text-sm text-status-error">
          Could not build the report. Is the API running?
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Days worked"
          value={totals ? totals.present + totals.late : '—'}
          hint={totals ? `${totals.records} rows in range` : undefined}
          icon={<BarChart3 className="h-5 w-5" aria-hidden />}
        />
        <StatCard
          label="Turnout"
          // An em dash, never 0%: `null` means nothing was expected in the
          // window, which is not the same as nobody turning up.
          value={formatRate(totals?.attendanceRate)}
          hint="Of the days people were expected"
        />
        <StatCard
          label="Late arrivals"
          value={totals ? totals.late : '—'}
          hint={totals ? `${Math.round(totals.lateMinutes)} minutes in total` : undefined}
        />
        <StatCard
          label="Average day"
          value={formatHours(totals?.avgWorkHours)}
          hint={totals ? `${formatHours(totals.workHours)} worked in all` : undefined}
        />
      </div>

      <Card className="p-6">
        <PanelHeader
          title="Turnout by day"
          hint={
            summary
              ? `${formatDateOnly(summary.range.startDate)} – ${formatDateOnly(summary.range.endDate)}`
              : undefined
          }
        />
        {isLoading ? (
          <div className="h-[260px] animate-pulse rounded-xl bg-surface-border/60" />
        ) : items.length === 0 ? (
          <p className="py-16 text-center text-sm text-text-muted">
            Nothing was recorded in this range.
          </p>
        ) : (
          <div className="h-[280px]">
            <BarOverviewChart
              items={items}
              height="100%"
              maxVal={axis.max}
              yAxisTicks={axis.ticks}
              minBarWidth={items.length > 16 ? 26 : undefined}
              // The stacked card sits over the bands it describes and clips at
              // the panel edge on the first and last day, so hover opens it.
              openHighlightTooltip={false}
            />
          </div>
        )}
      </Card>

      <Card>
        <div className="border-b border-surface-border-light px-5 py-4">
          <h3 className="text-base font-semibold text-text-heading">By department</h3>
          <p className="mt-0.5 text-sm text-text-muted">
            Where the days were worked, and where they were not.
          </p>
        </div>

        {!isLoading && (summary?.departments.length ?? 0) === 0 && (
          <EmptyState
            title="No departments in range"
            description="Widen the dates, or clear the branch filter."
          />
        )}

        {(summary?.departments.length ?? 0) > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="border-b border-surface-border-light text-xs uppercase tracking-wide text-text-muted">
                <tr>
                  <th className="px-5 py-3 text-start font-medium">Department</th>
                  <th className="px-5 py-3 text-start font-medium">People</th>
                  <th className="px-5 py-3 text-start font-medium">Present</th>
                  <th className="px-5 py-3 text-start font-medium">Late</th>
                  <th className="px-5 py-3 text-start font-medium">Absent</th>
                  <th className="px-5 py-3 text-start font-medium">On leave</th>
                  <th className="px-5 py-3 text-start font-medium">Hours</th>
                  <th className="px-5 py-3 text-start font-medium">Turnout</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border-light">
                {(summary?.departments ?? []).map((department) => (
                  <tr key={department.id} className="hover:bg-surface-border-light/60">
                    <td className="px-5 py-3 font-medium text-text-heading">{department.name}</td>
                    <td className="px-5 py-3 tabular-nums text-text-body">{department.headcount}</td>
                    <td className="px-5 py-3 tabular-nums text-text-body">{department.present}</td>
                    <td className="px-5 py-3 tabular-nums text-status-warning">{department.late}</td>
                    <td className="px-5 py-3 tabular-nums text-status-error">{department.absent}</td>
                    <td className="px-5 py-3 tabular-nums text-text-body">{department.onLeave}</td>
                    <td className="px-5 py-3 tabular-nums text-text-body">
                      {formatHours(department.workHours)}
                    </td>
                    <td className="px-5 py-3 font-semibold tabular-nums text-text-heading">
                      {formatRate(department.attendanceRate)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

export default function AttendanceReportsPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER', 'PAYROLL_OFFICER', 'MANAGER']}>
      <AttendanceReports />
    </ProtectedRoute>
  );
}

'use client';

import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Filter, Search, Users, Clock, Calendar, CalendarDays, PlusCircle } from 'lucide-react';
import { toast } from 'sonner';
import employeeService from '@/services/employeeService';
import calendarService from '@/services/calendarService';
import systemSettingsService from '@/services/systemSettingsService';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { apiErrorMessage } from '@/utils/apiError';
import { useBranchStore } from '@/store/branchStore';
import { usePageHeader } from '@/hooks/usePageHeader';
import {
    DEFAULT_LUNCH,
    LunchPolicy,
    daysOfMonth,
    monthBounds,
    parseWeeklyOffDays,
    roundHours,
    scheduledOvertimeOf,
    toCalendarDate,
    workHoursOf,
} from '@/utils/scheduleHours';

interface Employee {
    id: string;
    employeeCode: string;
    fullName: string;
    department: {
        name: string;
    };
}

export default function SchedulesOverviewPage() {
    // The one heading for this route, rendered by TopHeader.
    usePageHeader('Overview Calendar', 'Monitor shift schedules, leaves, and overtime company-wide');

    const selectedBranchId = useBranchStore((s) => s.selectedBranchId);
    const [loading, setLoading] = useState(true);
    const [employees, setEmployees] = useState<Employee[]>([]);
    const [currentDate, setCurrentDate] = useState(new Date());
    const [selectedDepartment, setSelectedDepartment] = useState<string>('');
    const [searchTerm, setSearchTerm] = useState('');
    const [overviewData, setOverviewData] = useState<{
        schedules: any[];
        leaves: any[];
        overtimes: any[];
        holidays: { id: string; date: string; name: string }[];
        weeklyOffDays: number[] | null;
    }>({ schedules: [], leaves: [], overtimes: [], holidays: [], weeklyOffDays: null });
    const [loadingData, setLoadingData] = useState(false);
    // The COMPANY default, used only until the endpoint answers — see
    // `weeklyHolidays` below, which prefers the branch's own week.
    const [companyWeeklyOff, setCompanyWeeklyOff] = useState<number[]>([0]);
    const [lunchPolicy, setLunchPolicy] = useState<LunchPolicy>(DEFAULT_LUNCH);
    const [companyTZ, setCompanyTZ] = useState('Asia/Kolkata');
    const [standardHoursPerDay, setStandardHoursPerDay] = useState(8);
    // A failed load and an empty month look identical without this: every fetch
    // used to swallow its error into console.error and fall back to [].
    //
    // TWO slots, not one. The screen runs two independent loaders — the staff
    // list and the month's schedule — and a single shared slot makes the banner
    // depend on which of them resolves LAST: a failed schedule load followed by
    // a successful employee load clears the error and the month goes back to
    // looking merely quiet. Each loader now owns its own message and the banner
    // shows whichever is set.
    const [overviewError, setOverviewError] = useState<string | null>(null);
    const [employeesError, setEmployeesError] = useState<string | null>(null);
    const error = overviewError ?? employeesError;

    useEffect(() => {
        fetchEmployees();
        fetchSettings();
    }, []);

    const fetchSettings = async () => {
        try {
            const res = await systemSettingsService.getAll();
            if (res?.success) {
                const val = (key: string, fallback: string) =>
                    res.data.find(s => s.key === key)?.value || fallback;
                setCompanyWeeklyOff(parseWeeklyOffDays(val('calendar_weekly_holidays', '0')));
                setCompanyTZ(val('system_timezone', 'Asia/Kolkata'));
                const stdHours = parseFloat(val('payroll_work_hours_per_day', '8'));
                setStandardHoursPerDay(isNaN(stdHours) || stdHours <= 0 ? 8 : stdHours);
                const [lh, lm] = val('lunch_break_start', '13:00').split(':').map(Number);
                const duration = parseInt(val('lunch_break_duration_minutes', '60'), 10);
                setLunchPolicy({
                    startMinutes: (isNaN(lh) ? 13 : lh) * 60 + (isNaN(lm) ? 0 : lm),
                    durationMinutes: isNaN(duration) ? 60 : Math.max(0, duration),
                });
            }
        } catch (err) {
            console.error('Failed to load system settings:', err);
        }
    };

    /**
     * Which days this BRANCH rests, not which days the company rests.
     *
     * `/calendar/overview` resolves `Branch.weeklyOffDays` for the branch in
     * context and falls back to the global setting itself, so its answer is
     * always the more specific one. The screen used to read
     * `calendar_weekly_holidays` directly and had no way to know better — an
     * Oman branch resting Fri/Sat was shaded Sat/Sun, and no client-side fix was
     * possible while the endpoint declined to say.
     *
     * The company default remains the fallback for the moment before the first
     * response lands, so the grid never renders a week with no rest day at all.
     */
    const weeklyHolidays = overviewData.weeklyOffDays ?? companyWeeklyOff;

    /** `YYYY-MM-DD` → holiday name, for the shaded columns and their tooltips. */
    const holidayByDate = useMemo(() => {
        const map = new Map<string, string>();
        overviewData.holidays?.forEach((h) => map.set(h.date, h.name));
        return map;
    }, [overviewData.holidays]);

    useEffect(() => {
        fetchOverviewData();
        // `selectedBranchId` is a dependency because the WORK WEEK and the
        // holidays are per branch: switching the picker has to re-ask, or the
        // grid keeps shading the previous branch's weekend.
    }, [currentDate, selectedBranchId]);

    const fetchOverviewData = async () => {
        try {
            setLoadingData(true);
            setOverviewError(null);
            // `monthBounds` reads the calendar parts directly. The previous
            // `toISOString().split('T')[0]` converted a LOCAL midnight to UTC,
            // so at any positive offset the range slid back a day and the last
            // day of the month was rendered by the grid but never requested —
            // a shift on the 31st was simply invisible.
            const { start, end } = monthBounds(currentDate);

            const response = await calendarService.getOverviewCalendar(start, end);

            if (response && response.data) {
                setOverviewData({
                    schedules: response.data.schedules ?? [],
                    leaves: response.data.leaves ?? [],
                    overtimes: response.data.overtimes ?? [],
                    holidays: response.data.holidays ?? [],
                    // `null` rather than `[]` when absent: an empty array is a
                    // legitimate answer meaning "this branch rests no days", and
                    // it must not be confused with "the server did not say".
                    weeklyOffDays: Array.isArray(response.data.weeklyOffDays)
                        ? response.data.weeklyOffDays
                        : null,
                });
            }
        } catch (err) {
            console.error('Error fetching calendar overview data:', err);
            setOverviewError(apiErrorMessage(err, 'Could not load the schedule for this month.'));
            setOverviewData({ schedules: [], leaves: [], overtimes: [], holidays: [], weeklyOffDays: null });
        } finally {
            setLoadingData(false);
        }
    };

    const fetchEmployees = async () => {
        try {
            setLoading(true);
            setEmployeesError(null);
            const response = await employeeService.getAll({ status: 'ACTIVE', limit: 500 });

            if (!response || !response.data) {
                console.error('Invalid response from API:', response);
                setEmployees([]);
                setEmployeesError('The staff list came back in a shape this screen cannot read.');
                return;
            }

            setEmployees(response.data || []);
        } catch (err: any) {
            console.error('Error loading employee list:', err);
            setEmployees([]);
            setEmployeesError(apiErrorMessage(err, 'Could not load the staff list.'));
        } finally {
            setLoading(false);
        }
    };

    const getDaysInMonth = () => daysOfMonth(currentDate);

    const previousMonth = () => {
        setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1));
    };

    const nextMonth = () => {
        setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1));
    };

    const monthNames = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'
    ];

    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    const filteredEmployees = employees.filter(emp => {
        const matchesSearch = emp.fullName.toLowerCase().includes(searchTerm.toLowerCase()) ||
            emp.employeeCode.toLowerCase().includes(searchTerm.toLowerCase());
        const matchesDepartment = !selectedDepartment || emp.department.name === selectedDepartment;
        return matchesSearch && matchesDepartment;
    });

    const departments = [...new Set(employees.map(emp => emp.department.name))].sort();

    // The hours arithmetic lives in `utils/scheduleHours.ts`. It used to be
    // copied here and again in the shift-management screen, with both copies
    // claiming to "mirror the backend rule" — two copies of a rule that has to
    // agree with a third implementation.
    const hoursOpts = { lunch: lunchPolicy, timeZone: companyTZ };

    /** A `WorkSchedule` row from `/calendar/overview`, in the helper's shape. */
    const asShift = (schedule: any) => ({
        isWorkDay: schedule.isWorkDay,
        shiftType: schedule.shiftType,
        requiredHours: schedule.requiredHours,
        start: schedule.startTime,
        end: schedule.endTime,
    });

    // Rounded per cell, because the stat tiles sum these and a user checks the
    // tiles against the grid. See the note in `workHoursOf`.
    const getWorkHours = (schedule: any) => roundHours(workHoursOf(asShift(schedule), hoursOpts));

    // Overtime implied by a scheduled shift: any worked hours beyond the
    // standard working hours per day count as overtime for that shift.
    const getScheduledOvertime = (schedule: any) =>
        roundHours(scheduledOvertimeOf(asShift(schedule), { ...hoursOpts, standardHoursPerDay }));

    const formatTime12h = (timeStr: string) => {
        if (!timeStr) return '';
        const date = new Date(timeStr);
        return date.toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
            hour12: true
        });
    };

    const getAvatarGradient = (name: string) => {
        const colors = [
            'from-brand-primary to-indigo-600',
            'from-purple-500 to-indigo-600',
            'from-teal-500 to-emerald-600',
            'from-brand-accent to-amber-600',
            'from-rose-500 to-pink-600',
            'from-sky-500 to-brand-primary'
        ];
        let hash = 0;
        for (let i = 0; i < name.length; i++) {
            hash = name.charCodeAt(i) + ((hash << 5) - hash);
        }
        const index = Math.abs(hash) % colors.length;
        return colors[index];
    };

    const getOverviewStats = () => {
        let totalShifts = 0;
        let totalHours = 0;
        let totalLeaves = 0;
        let totalOvertime = 0;
        const scheduledStaffSet = new Set<string>();

        filteredEmployees.forEach(emp => {
            getDaysInMonth().forEach(date => {
                const dateStr = toCalendarDate(date);
                
                const leave = overviewData.leaves.find(l => 
                    l.employeeId === emp.id && dateStr >= l.startDate && dateStr <= l.endDate
                );
                if (leave) {
                    totalLeaves++;
                    return;
                }

                const schedule = overviewData.schedules.find(s => 
                    s.employeeId === emp.id && s.date === dateStr
                );
                if (schedule) {
                    totalShifts++;
                    totalHours += getWorkHours(schedule);
                    totalOvertime += getScheduledOvertime(schedule);
                    scheduledStaffSet.add(emp.id);
                } else {
                    // Standalone approved overtime (no scheduled shift that day)
                    const overtime = overviewData.overtimes.find(o =>
                        o.employeeId === emp.id && o.date === dateStr
                    );
                    if (overtime) {
                        totalOvertime += overtime.hours;
                    }
                }
            });
        });

        return {
            totalStaffScheduled: scheduledStaffSet.size,
            totalShifts,
            totalHours: Math.round(totalHours * 10) / 10,
            totalLeaves,
            totalOvertime: Math.round(totalOvertime * 10) / 10
        };
    };

    const stats = getOverviewStats();

    return (
        <ProtectedRoute requiredPermission="VIEW_ALL_SCHEDULES">
            <>
                <div className="space-y-6">
                    {/* A refused or failed load must not read as a quiet month. */}
                    {error && (
                        <div
                            data-testid="schedule-error"
                            role="alert"
                            className="bg-status-error-bg/40 border border-status-error/30 text-status-error rounded-[--radius-card] px-4 py-3 text-sm font-medium"
                        >
                            {error}
                        </div>
                    )}

                    {/* Company Stats Summary */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                        <div className="bg-brand-primary-light/10 border border-brand-primary-light/30 rounded-[--radius-card] p-4 flex items-center gap-3.5 shadow-2xs hover:shadow-xs transition-all">
                            <div className="w-10 h-10 rounded-[--radius-button] bg-brand-primary text-text-on-brand flex items-center justify-center shadow-xs shrink-0">
                                <Users size={20} />
                            </div>
                            <div className="min-w-0">
                                <p className="text-xs text-text-muted font-bold tracking-wide uppercase">Scheduled Staff</p>
                                <p data-testid="schedule-stat-staff" className="text-xl font-extrabold text-text-heading mt-0.5 truncate">{stats.totalStaffScheduled} / {filteredEmployees.length}</p>
                            </div>
                        </div>

                        <div className="bg-status-success-bg/30 border border-status-success/30 rounded-[--radius-card] p-4 flex items-center gap-3.5 shadow-2xs hover:shadow-xs transition-all">
                            <div className="w-10 h-10 rounded-[--radius-button] bg-status-success text-white flex items-center justify-center shadow-xs shrink-0">
                                <Clock size={20} />
                            </div>
                            <div className="min-w-0">
                                <p className="text-xs text-text-muted font-bold tracking-wide uppercase">Scheduled Hours</p>
                                <p data-testid="schedule-stat-hours" className="text-xl font-extrabold text-text-heading mt-0.5 truncate">{stats.totalHours} hrs</p>
                            </div>
                        </div>

                        <div className="bg-status-warning-bg/30 border border-status-warning/30 rounded-[--radius-card] p-4 flex items-center gap-3.5 shadow-2xs hover:shadow-xs transition-all">
                            <div className="w-10 h-10 rounded-[--radius-button] bg-brand-accent text-text-on-accent flex items-center justify-center shadow-xs shrink-0">
                                <Calendar size={20} />
                            </div>
                            <div className="min-w-0">
                                <p className="text-xs text-text-muted font-bold tracking-wide uppercase">Planned Leaves</p>
                                <p data-testid="schedule-stat-leaves" className="text-xl font-extrabold text-text-heading mt-0.5 truncate">{stats.totalLeaves} days</p>
                            </div>
                        </div>

                        <div className="bg-status-info-bg/30 border border-status-info/30 rounded-[--radius-card] p-4 flex items-center gap-3.5 shadow-2xs hover:shadow-xs transition-all">
                            <div className="w-10 h-10 rounded-[--radius-button] bg-status-info text-white flex items-center justify-center shadow-xs shrink-0">
                                <PlusCircle size={20} />
                            </div>
                            <div className="min-w-0">
                                <p className="text-xs text-text-muted font-bold tracking-wide uppercase">Overtime Logs</p>
                                <p data-testid="schedule-stat-overtime" className="text-xl font-extrabold text-text-heading mt-0.5 truncate">{stats.totalOvertime} hrs</p>
                            </div>
                        </div>
                    </div>

                    {/* Filters */}
                    <div className="bg-surface-card rounded-[--radius-card] border border-surface-border p-4 shadow-xs">
                        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                            <div className="flex flex-wrap items-center gap-3 flex-1">
                                <div className="flex items-center gap-2 text-text-body font-semibold text-sm">
                                    <Filter size={18} className="text-text-muted" />
                                    <span>Filter By:</span>
                                </div>
                                
                                {/* Search Employee */}
                                <div className="relative min-w-[240px]">
                                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" size={16} />
                                    <input
                                        data-testid="schedule-search"
                                        type="text"
                                        placeholder="Search by name, code..."
                                        value={searchTerm}
                                        onChange={(e) => setSearchTerm(e.target.value)}
                                        className="w-full pl-9 pr-4 py-2 border border-surface-border bg-surface-card text-text-body rounded-[--radius-input] focus:ring-2 focus:ring-brand-primary/20 focus:border-transparent text-sm"
                                    />
                                </div>

                                {/* Department Filter */}
                                <select
                                    data-testid="schedule-department-filter"
                                    value={selectedDepartment}
                                    onChange={(e) => setSelectedDepartment(e.target.value)}
                                    className="px-3 py-2 border border-surface-border rounded-[--radius-input] text-text-body focus:ring-2 focus:ring-brand-primary/20 focus:border-transparent text-sm bg-surface-card"
                                >
                                    <option value="">All departments</option>
                                    {departments.map((dept) => (
                                        <option key={dept} value={dept}>
                                            {dept}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div className="text-sm font-medium text-text-muted">
                                Showing <span data-testid="schedule-result-count" className="text-text-heading font-bold">{filteredEmployees.length}</span> staff members
                            </div>
                        </div>
                    </div>

                    {/* Calendar */}
                    <div className="bg-surface-card rounded-[--radius-card] border border-surface-border p-6">
                        {/* Month Navigation */}
                        <div className="flex items-center justify-between mb-6">
                            <button
                                data-testid="schedule-prev-month"
                                onClick={previousMonth}
                                className="p-2 hover:bg-surface-page rounded-[--radius-button] text-text-body transition-colors flex items-center gap-2 cursor-pointer"
                            >
                                <ChevronLeft size={20} />
                                Last month
                            </button>
                            <h2 data-testid="schedule-current-month" className="text-xl font-bold text-text-heading">
                                {monthNames[currentDate.getMonth()]} {currentDate.getFullYear()}
                            </h2>
                            <button
                                data-testid="schedule-next-month"
                                onClick={nextMonth}
                                className="p-2 hover:bg-surface-page rounded-[--radius-button] text-text-body transition-colors flex items-center gap-2 cursor-pointer"
                            >
                                Next month
                                <ChevronRight size={20} />
                            </button>
                        </div>

                        {loading || loadingData ? (
                            <div data-testid="schedule-loading" className="h-96 flex items-center justify-center">
                                <div className="w-8 h-8 border-4 border-brand-primary border-t-transparent rounded-full animate-spin"></div>
                            </div>
                        ) : filteredEmployees.length === 0 ? (
                            <div data-testid="schedule-empty" className="py-20 text-center">
                                <div className="w-16 h-16 rounded-full bg-surface-page flex items-center justify-center mx-auto mb-4">
                                    <Users size={32} className="text-text-muted" />
                                </div>
                                <h3 className="text-lg font-semibold text-text-heading mb-1">No staff to show</h3>
                                <p className="text-text-muted text-sm">
                                    {employees.length === 0
                                        ? 'No active staff are visible in the selected branch.'
                                        : 'No one matches the current search and department filter.'}
                                </p>
                            </div>
                        ) : (
                            <div className="overflow-auto max-h-[600px] border border-surface-border rounded-[--radius-card] shadow-xs">
                                <table className="w-full border-collapse">
                                    <thead>
                                        <tr className="bg-surface-page">
                                            <th className="border border-surface-border p-3 text-left font-semibold sticky top-0 left-0 bg-surface-page text-text-heading z-30 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.05)]">
                                                Employee
                                            </th>
                                            {getDaysInMonth().map((date) => {
                                                const dayOfWeek = date.getDay();
                                                const isWeekend = weeklyHolidays.includes(dayOfWeek);
                                                const holidayName = holidayByDate.get(toCalendarDate(date));
                                                return (
                                                    <th
                                                        key={toCalendarDate(date)}
                                                        data-testid={`schedule-day-header-${date.getDate()}`}
                                                        data-weekend={isWeekend ? 'true' : 'false'}
                                                        data-holiday={holidayName ? 'true' : 'false'}
                                                        title={holidayName ?? undefined}
                                                        className={`border border-surface-border p-2 text-center min-w-[60px] sticky top-0 z-20 ${
                                                            holidayName
                                                                ? 'bg-status-success-bg text-text-body'
                                                                : isWeekend
                                                                    ? 'bg-surface-page text-text-body'
                                                                    : 'bg-surface-page'
                                                        }`}
                                                    >
                                                        <div className="text-xs text-text-muted">
                                                            {dayNames[date.getDay()]}
                                                        </div>
                                                        <div className="font-bold text-sm text-text-heading">{date.getDate()}</div>
                                                    </th>
                                                );
                                            })}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filteredEmployees.map((emp) => (
                                            <tr
                                                key={emp.id}
                                                data-testid={`schedule-employee-row-${emp.employeeCode}`}
                                                className="hover:bg-surface-page/50"
                                            >
                                                <td className="border border-surface-border p-3 sticky left-0 bg-surface-card z-10 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.08)]">
                                                    <div className="flex items-center gap-2.5 min-w-[200px]">
                                                        <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-xs shadow-xs text-white shrink-0 bg-gradient-to-r ${getAvatarGradient(emp.fullName)}`}>
                                                            {emp.fullName.substring(0, 2).toUpperCase()}
                                                        </div>
                                                        <div className="min-w-0">
                                                            <p className="font-bold text-sm text-text-heading truncate">{emp.fullName}</p>
                                                            <p className="text-[11px] text-text-muted font-semibold mt-0.5">{emp.employeeCode}</p>
                                                            <p className="text-[10px] text-text-muted font-medium truncate">{emp.department.name}</p>
                                                        </div>
                                                    </div>
                                                </td>
                                                {getDaysInMonth().map((date) => {
                                                    const dayOfWeek = date.getDay();
                                                    const isWeekend = weeklyHolidays.includes(dayOfWeek);

                                                     const dateStr = toCalendarDate(date);
                                                    const holidayName = holidayByDate.get(dateStr);
                                                    
                                                    const leave = overviewData.leaves.find(l => 
                                                        l.employeeId === emp.id && dateStr >= l.startDate && dateStr <= l.endDate
                                                    );
                                                    const overtime = overviewData.overtimes.find(o => 
                                                        o.employeeId === emp.id && o.date === dateStr
                                                    );
                                                    const schedule = overviewData.schedules.find(s => 
                                                        s.employeeId === emp.id && s.date === dateStr
                                                    );

                                                    return (
                                                        <td
                                                            key={toCalendarDate(date)}
                                                            data-testid={`schedule-cell-${emp.employeeCode}-${dateStr}`}
                                                            data-weekend={isWeekend ? 'true' : 'false'}
                                                            data-holiday={holidayName ? 'true' : 'false'}
                                                            title={holidayName ?? undefined}
                                                            className={`border border-surface-border p-1 text-center ${
                                                                holidayName
                                                                    ? 'bg-status-success-bg/50'
                                                                    : isWeekend
                                                                        ? 'bg-surface-page/30'
                                                                        : ''
                                                            }`}
                                                        >
                                                            {leave ? (
                                                                <div data-testid="schedule-leave-cell" className="w-full h-8 bg-status-warning-bg/40 border border-status-warning/20 rounded-[--radius-button] flex items-center justify-center text-[10px] text-status-warning font-semibold" title={leave.leaveType}>
                                                                    Leave
                                                                </div>
                                                            ) : schedule ? (
                                                                <button
                                                                    type="button"
                                                                    data-testid="schedule-shift-cell"
                                                                    data-shift-type={schedule.shiftType}
                                                                    onClick={() => {
                                                                        const shiftName = schedule.shiftType.charAt(0) + schedule.shiftType.slice(1).toLowerCase();
                                                                        toast.info(
                                                                            `${shiftName} Shift`,
                                                                            {
                                                                                description: `Scheduled: ${formatTime12h(schedule.startTime)} - ${formatTime12h(schedule.endTime)}`,
                                                                                duration: 4000,
                                                                            }
                                                                        );
                                                                    }}
                                                                    className="w-full h-8 bg-brand-primary-light/40 hover:bg-brand-primary-light/60 border border-brand-primary-light rounded-[--radius-button] flex flex-col items-center justify-center leading-tight text-xs text-brand-primary-dark font-bold animate-fadeIn transition-colors cursor-pointer"
                                                                    title={`${schedule.shiftType.charAt(0) + schedule.shiftType.slice(1).toLowerCase()} shift: ${formatTime12h(schedule.startTime)} - ${formatTime12h(schedule.endTime)}${getScheduledOvertime(schedule) > 0 ? ` (incl. ${getScheduledOvertime(schedule)}h OT)` : ''}`}
                                                                >
                                                                    <span>{getWorkHours(schedule)}h</span>
                                                                    {getScheduledOvertime(schedule) > 0 && (
                                                                        <span className="text-[9px] text-status-info font-semibold">+{getScheduledOvertime(schedule)}h OT</span>
                                                                    )}
                                                                </button>
                                                            ) : overtime ? (
                                                                <div data-testid="schedule-overtime-cell" className="w-full h-8 bg-status-info-bg/40 border border-status-info/20 rounded-[--radius-button] flex items-center justify-center text-[10px] text-status-info font-semibold">
                                                                    {overtime.hours}h OT
                                                                </div>
                                                            ) : null}
                                                        </td>
                                                    );
                                                })}
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>

                    {/* Legend */}
                    <div className="bg-surface-card rounded-[--radius-card] border border-surface-border p-4">
                        <h3 className="font-semibold text-text-heading mb-3">Note:</h3>
                        <div className="flex items-center gap-6 flex-wrap">
                            <div className="flex items-center gap-2">
                                <div className="w-6 h-6 bg-brand-primary-light rounded border border-brand-primary-light"></div>
                                <span className="text-sm text-text-body">Work</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="w-6 h-6 bg-status-warning-bg/40 rounded border border-status-warning/20"></div>
                                <span className="text-sm text-text-body">On leave</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="w-6 h-6 bg-status-info-bg/40 rounded border border-status-info/20"></div>
                                <span className="text-sm text-text-body">Overtime</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="w-6 h-6 bg-surface-page rounded border border-surface-border"></div>
                                {/* "Weekly off" rather than "Weekend": the shaded
                                    days come from this BRANCH's work week, and an
                                    Oman branch's rest days are Friday and
                                    Saturday. Calling them the weekend states
                                    something the business did not say. */}
                                <span className="text-sm text-text-body">Weekly off</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="w-6 h-6 bg-status-success-bg rounded border border-status-success/20"></div>
                                <span className="text-sm text-text-body">Holiday</span>
                            </div>
                        </div>
                    </div>
                </div>
            </>
        </ProtectedRoute>
    );
}

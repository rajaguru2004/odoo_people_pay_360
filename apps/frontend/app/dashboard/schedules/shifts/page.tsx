'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Users, Plus, Search, Filter, ChevronLeft, ChevronRight, Calendar as CalendarIcon, Clock, CalendarDays } from 'lucide-react';
import { EventClickArg, DateSelectArg } from '@fullcalendar/core';
import employeeService from '@/services/employeeService';
import calendarService from '@/services/calendarService';
import systemSettingsService from '@/services/systemSettingsService';
import ScheduleModal from '@/components/calendar/ScheduleModal';
import BulkScheduleModal from '@/components/calendar/BulkScheduleModal';
import FullCalendarView from '@/components/calendar/FullCalendarView';

// RBAC
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePermission } from '@/hooks/usePermission';
import { usePageHeader } from '@/hooks/usePageHeader';
import PageActionRow from '@/components/common/PageActionRow';
import { apiErrorMessage } from '@/utils/apiError';
import {
    DEFAULT_LUNCH,
    LunchPolicy,
    monthBounds,
    roundHours,
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

export default function SchedulesManagementPage() {
    // The one heading for this route, rendered by TopHeader.
    usePageHeader('Shift', 'Manage detailed work schedules for each employee');

    const router = useRouter();
    const { can } = usePermission();
    const [loading, setLoading] = useState(true);
    const [employees, setEmployees] = useState<Employee[]>([]);
    const [selectedEmployee, setSelectedEmployee] = useState<string>('');
    const [searchTerm, setSearchTerm] = useState('');
    const [events, setEvents] = useState<any[]>([]);
    const [isScheduleModalOpen, setIsScheduleModalOpen] = useState(false);
    const [isBulkScheduleModalOpen, setIsBulkScheduleModalOpen] = useState(false);
    const [selectedScheduleId, setSelectedScheduleId] = useState<string | undefined>();
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [selectedDate, setSelectedDate] = useState<Date | null>(null);
    const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
    const [selectedDepartment, setSelectedDepartment] = useState<string>('');
    const [dateRange, setDateRange] = useState<{ start: Date; end: Date } | null>(null);
    const [lunchPolicy, setLunchPolicy] = useState<LunchPolicy>(DEFAULT_LUNCH);
    const [companyTZ, setCompanyTZ] = useState('Asia/Kolkata');
    // Without this a refused or failed load renders as an empty calendar, which
    // is indistinguishable from an employee who genuinely has no shifts.
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        fetchEmployees();
        fetchSettings();
    }, []);

    const fetchSettings = async () => {
        try {
            const res = await systemSettingsService.getAll();
            if (res?.success) {
                const val = (key: string, fallback: string) =>
                    res.data.find((s: any) => s.key === key)?.value || fallback;
                setCompanyTZ(val('system_timezone', 'Asia/Kolkata'));
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

    useEffect(() => {
        if (selectedEmployee) {
            fetchEmployeeSchedules();
        }
    }, [selectedEmployee, dateRange]);

    const fetchEmployees = async () => {
        try {
            setLoading(true);
            setError(null);
            const response = await employeeService.getAll({ status: 'ACTIVE', limit: 500 });

            if (!response || !response.data) {
                console.error('Invalid response from API:', response);
                setEmployees([]);
                setError('The staff list came back in a shape this screen cannot read.');
                return;
            }

            setEmployees(response.data || []);
            if (response.data && response.data.length > 0) {
                setSelectedEmployee(response.data[0].id);
            }
        } catch (err: any) {
            console.error('Error loading employee list:', err);
            setEmployees([]);
            setError(apiErrorMessage(err, 'Could not load the staff list.'));
        } finally {
            setLoading(false);
        }
    };

    const fetchEmployeeSchedules = async (start?: Date, end?: Date) => {
        if (!selectedEmployee) return;

        try {
            let startDate = start;
            let endDate = end;

            if (!startDate || !endDate) {
                if (dateRange) {
                    startDate = dateRange.start;
                    endDate = dateRange.end;
                } else {
                    // No range yet: fall back to the whole of the current month.
                    const { start: s, end: e } = monthBounds(new Date());
                    startDate = new Date(`${s}T00:00:00`);
                    endDate = new Date(`${e}T00:00:00`);
                }
            }

            setError(null);
            // `toCalendarDate` rather than `toISOString()`: these Dates are
            // local wall-clock (FullCalendar hands back the visible range, and
            // the fallback above is local midnight), so converting to UTC moved
            // the window by a day at any positive offset.
            const response = await calendarService.getMyCalendar(
                toCalendarDate(startDate),
                toCalendarDate(endDate),
                selectedEmployee
            );
            setEvents(response.data || []);
        } catch (err) {
            console.error('Error loading work schedule:', err);
            setEvents([]);
            setError(apiErrorMessage(err, 'Could not load this employee\'s schedule.'));
        }
    };

    const handleDatesSet = (start: Date, end: Date) => {
        setDateRange({ start, end });
    };

    const handleScheduleSuccess = () => {
        fetchEmployeeSchedules();
    };

    /**
     * Deleting a shift used to be reachable only from `/dashboard/my-calendar`,
     * so the screen that creates and edits shifts could not remove one — and
     * `DELETE_SCHEDULE` was a permission nothing in the app consulted.
     */
    const handleDeleteSchedule = async (scheduleId: string) => {
        if (!window.confirm('Delete this shift? This cannot be undone.')) return;
        try {
            setDeletingId(scheduleId);
            await calendarService.deleteSchedule(scheduleId);
            setError(null);
            await fetchEmployeeSchedules();
        } catch (err) {
            console.error('Error deleting work schedule:', err);
            setError(apiErrorMessage(err, 'Could not delete this shift.'));
        } finally {
            setDeletingId(null);
        }
    };

    // Convert events to FullCalendar format
    const fullCalendarEvents = events.map(event => ({
        id: event.id,
        title: event.title,
        start: event.startDate,
        end: event.endDate,
        allDay: event.allDay,
        extendedProps: {
            type: event.type,
            description: event.description
        }
    }));

    const handleEventClick = (info: EventClickArg) => {
        const event = events.find(e => e.id === info.event.id);
        if (event && event.type === 'work' && can('EDIT_SCHEDULE')) {
            setSelectedScheduleId(event.id);
            setIsScheduleModalOpen(true);
        }
    };

    const handleDateSelect = (info: DateSelectArg) => {
        if (!can('CREATE_SCHEDULE')) return;
        setSelectedDate(info.start);
        setIsScheduleModalOpen(true);
    };

    const filteredEmployees = employees.filter(emp => {
        const matchesSearch = emp.fullName.toLowerCase().includes(searchTerm.toLowerCase()) ||
            emp.employeeCode.toLowerCase().includes(searchTerm.toLowerCase());
        const matchesDepartment = !selectedDepartment || emp.department.name === selectedDepartment;
        return matchesSearch && matchesDepartment;
    });

    const selectedEmployeeData = employees.find(emp => emp.id === selectedEmployee);

    // Get unique departments for filter
    const departments = [...new Set(employees.map(emp => emp.department.name))].sort();

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

    const getEmployeeStats = () => {
        let totalShifts = 0;
        let totalHours = 0;
        let totalLeaves = 0;
        let totalOvertimes = 0;

        // The lunch and flexible-hours rules come from `utils/scheduleHours.ts`,
        // which the overview screen reads too — they used to be two copies of
        // one rule that both had to match the server.
        const hoursOpts = { lunch: lunchPolicy, timeZone: companyTZ };

        events.forEach(event => {
            if (event.type === 'work') {
                totalShifts++;
                // Sums raw and rounds once at the end, which is what this
                // screen has always done. The overview rounds per cell instead,
                // so its tiles reconcile with its grid.
                totalHours += workHoursOf(
                    {
                        shiftType: event.shiftType,
                        requiredHours: event.requiredHours,
                        start: event.startDate,
                        end: event.endDate,
                    },
                    hoursOpts,
                );
            } else if (event.type === 'leave') {
                totalLeaves++;
            } else if (event.type === 'overtime') {
                if (event.startDate && event.endDate) {
                    const start = new Date(event.startDate);
                    const end = new Date(event.endDate);
                    const diffHours = (end.getTime() - start.getTime()) / (1000 * 60 * 60);
                    totalOvertimes += diffHours;
                } else {
                    totalOvertimes += 1;
                }
            }
        });

        return {
            totalShifts,
            totalHours: roundHours(totalHours),
            totalLeaves,
            totalOvertimes: roundHours(totalOvertimes)
        };
    };

    const stats = getEmployeeStats();
    /** Work shifts only — leave and overtime are read-only on this screen. */
    const workEvents = events.filter(e => e.type === 'work');

    return (
        <ProtectedRoute requiredPermission="VIEW_ALL_SCHEDULES">
            <>
                <div className="space-y-6">
                    {/* The title/description live in the sticky TopHeader (declared via
                        usePageHeader above); only the actions belong on the page. */}
                    <PageActionRow
                        action={
                          <>
                            {can('BULK_CREATE_SCHEDULES') && (
                            <button
                                data-testid="shift-bulk-create"
                                onClick={() => setIsBulkScheduleModalOpen(true)}
                                className="px-5 py-2.5 bg-brand-accent text-text-on-accent rounded-[--radius-button] hover:bg-brand-accent-dark transition-all shadow-md hover:shadow-lg flex items-center gap-2 font-semibold cursor-pointer"
                            >
                                <Users size={18} />
                                Create in bulk
                            </button>
                            )}
                            {can('CREATE_SCHEDULE') && (
                            <button
                                data-testid="shift-create"
                                onClick={() => {
                                    setSelectedScheduleId(undefined);
                                    setSelectedDate(null);
                                    setIsScheduleModalOpen(true);
                                }}
                                className="px-5 py-2.5 bg-brand-primary text-text-on-brand rounded-[--radius-button] hover:bg-brand-primary-dark transition-all shadow-md hover:shadow-lg flex items-center gap-2 font-semibold cursor-pointer"
                            >
                                <Plus size={18} />
                                Create a calendar
                            </button>
                            )}
                          </>
                        }
                    />

                    {error && (
                        <div
                            data-testid="shift-error"
                            role="alert"
                            className="bg-status-error-bg/40 border border-status-error/30 text-status-error rounded-[--radius-card] px-4 py-3 text-sm font-medium"
                        >
                            {error}
                        </div>
                    )}

                    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                        {/* Collapsible Employee Sidebar */}
                        {!isSidebarCollapsed && (
                            <div className="lg:col-span-3">
                                <div className="bg-surface-card rounded-[--radius-card] border border-surface-border shadow-sm">
                                    {/* Sidebar Header */}
                                    <div className="p-4 border-b border-surface-border bg-gradient-to-r from-surface-page to-brand-primary-light/10">
                                        <div className="flex items-center justify-between mb-3">
                                            <div className="flex items-center gap-2">
                                                <Users size={20} className="text-brand-primary" />
                                                <h3 className="font-bold text-lg text-text-heading">Employee</h3>
                                            </div>
                                            <button
                                                data-testid="shift-sidebar-collapse"
                                                onClick={() => setIsSidebarCollapsed(true)}
                                                className="p-1.5 hover:bg-surface-page rounded-[--radius-button] transition-colors cursor-pointer"
                                                title="Collapse"
                                            >
                                                <ChevronLeft size={18} className="text-text-body" />
                                            </button>
                                        </div>

                                        {/* Quick Stats */}
                                        <div className="flex items-center gap-2 text-sm text-text-muted">
                                            <span className="font-semibold">{filteredEmployees.length}</span>
                                            <span>employees</span>
                                        </div>
                                    </div>

                                    <div className="p-4">
                                        {/* Advanced Filters */}
                                        <div className="space-y-3 mb-4">
                                            {/* Search */}
                                            <div className="relative">
                                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" size={18} />
                                                <input
                                                    data-testid="shift-employee-search"
                                                    type="text"
                                                    placeholder="Search by name, NV code..."
                                                    value={searchTerm}
                                                    onChange={(e) => setSearchTerm(e.target.value)}
                                                    className="w-full pl-10 pr-4 py-2.5 border border-surface-border bg-surface-card text-text-body rounded-[--radius-input] focus:ring-2 focus:ring-brand-primary/20 focus:border-transparent text-sm"
                                                />
                                            </div>

                                            {/* Department Filter */}
                                            <div className="relative">
                                                <Filter className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" size={18} />
                                                <select
                                                    data-testid="shift-department-filter"
                                                    value={selectedDepartment}
                                                    onChange={(e) => setSelectedDepartment(e.target.value)}
                                                    className="w-full pl-10 pr-4 py-2.5 border border-surface-border bg-surface-card text-text-body rounded-[--radius-input] focus:ring-2 focus:ring-brand-primary/20 focus:border-transparent text-sm appearance-none"
                                                >
                                                    <option value="">All departments</option>
                                                    {departments.map((dept) => (
                                                        <option key={dept} value={dept}>
                                                            {dept}
                                                        </option>
                                                    ))}
                                                </select>
                                            </div>
                                        </div>

                                        {/* Employee List */}
                                        <div className="space-y-2 overflow-y-auto custom-scrollbar" style={{ maxHeight: '600px' }}>
                                            {loading ? (
                                                <div data-testid="shift-employee-loading" className="text-center py-12">
                                                    <div className="w-8 h-8 border-4 border-brand-primary border-t-transparent rounded-full animate-spin mx-auto"></div>
                                                    <p className="text-sm text-text-muted mt-3">Loading...</p>
                                                </div>
                                            ) : filteredEmployees.length === 0 ? (
                                                <div data-testid="shift-employee-empty" className="text-center py-12">
                                                    <Users size={48} className="mx-auto text-text-muted mb-3" />
                                                    <p className="text-text-muted">No staff found</p>
                                                </div>
                                            ) : (
                                                filteredEmployees.map((emp) => (
                                                    <button
                                                        key={emp.id}
                                                        data-testid={`shift-employee-item-${emp.employeeCode}`}
                                                        onClick={() => setSelectedEmployee(emp.id)}
                                                        className={`w-full text-left p-3 rounded-[--radius-card] transition-all cursor-pointer ${selectedEmployee === emp.id
                                                            ? 'bg-brand-primary-light/30 border-2 border-brand-primary shadow-xs'
                                                            : 'hover:bg-surface-page border-2 border-transparent hover:border-surface-border'
                                                            }`}
                                                    >
                                                        <div className="flex items-center gap-3">
                                                            <div className={`w-9 h-9 rounded-full flex items-center justify-center font-bold text-xs shadow-xs text-white bg-gradient-to-r ${getAvatarGradient(emp.fullName)}`}>
                                                                {emp.fullName.substring(0, 2).toUpperCase()}
                                                            </div>
                                                            <div className="flex-1 min-w-0">
                                                                <p className="font-bold text-sm text-text-heading truncate">{emp.fullName}</p>
                                                                <p className="text-[11px] text-text-muted mt-0.5 font-medium">{emp.employeeCode}</p>
                                                                <div className="flex items-center gap-1 mt-1">
                                                                    <div className="w-1.5 h-1.5 rounded-full bg-brand-primary shrink-0"></div>
                                                                    <p className="text-[10px] text-text-muted font-medium truncate">{emp.department.name}</p>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    </button>
                                                ))
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Collapsed Sidebar Button */}
                        {isSidebarCollapsed && (
                            <div className="lg:col-span-1">
                                <button
                                    data-testid="shift-sidebar-expand"
                                    onClick={() => setIsSidebarCollapsed(false)}
                                    className="w-full bg-surface-card rounded-[--radius-card] border border-surface-border p-4 hover:bg-surface-page transition-colors shadow-sm cursor-pointer"
                                    title="Extend"
                                >
                                    <ChevronRight size={20} className="mx-auto text-text-body" />
                                    <Users size={20} className="mx-auto text-brand-primary mt-2" />
                                    <p className="text-xs text-text-body mt-2 font-semibold">Employee</p>
                                </button>
                            </div>
                        )}

                        {/* Calendar View - Expanded when sidebar collapsed */}
                        <div className={isSidebarCollapsed ? 'lg:col-span-11' : 'lg:col-span-9'}>
                            <div className="bg-surface-card rounded-[--radius-card] border border-surface-border shadow-sm">
                                {selectedEmployeeData ? (
                                    <>
                                        {/* Employee Info Header */}
                                        <div className="p-6 border-b border-surface-border bg-gradient-to-r from-surface-page to-brand-primary-light/10">
                                            <div className="flex items-center justify-between flex-wrap gap-4">
                                                <div className="flex items-center gap-4">
                                                    <div className={`w-12 h-12 rounded-full bg-gradient-to-r ${getAvatarGradient(selectedEmployeeData.fullName)} flex items-center justify-center text-white font-bold text-lg shadow-sm`}>
                                                        {selectedEmployeeData.fullName.substring(0, 2).toUpperCase()}
                                                    </div>
                                                    <div>
                                                        <h3 className="text-xl font-bold text-text-heading">{selectedEmployeeData.fullName}</h3>
                                                        <div className="flex items-center gap-3 mt-1 text-text-muted text-sm">
                                                            <span className="font-semibold">{selectedEmployeeData.employeeCode}</span>
                                                            <span>•</span>
                                                            <span className="font-medium">{selectedEmployeeData.department.name}</span>
                                                        </div>
                                                    </div>
                                                </div>
                                                {can('CREATE_SCHEDULE') && (
                                                <button
                                                    data-testid="shift-create-inline"
                                                    onClick={() => {
                                                        setSelectedScheduleId(undefined);
                                                        setSelectedDate(null);
                                                        setIsScheduleModalOpen(true);
                                                    }}
                                                    className="px-4 py-2 bg-brand-primary text-text-on-brand text-sm rounded-[--radius-button] hover:bg-brand-primary-dark transition-all shadow-sm hover:shadow-md flex items-center gap-2 font-semibold cursor-pointer"
                                                >
                                                    <Plus size={16} />
                                                    Add calendar
                                                </button>
                                                )}
                                            </div>
                                        </div>

                                        {/* Calendar Content */}
                                        <div className="p-6">
                                            {/* Statistics Row */}
                                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                                                <div className="bg-brand-primary-light/10 border border-brand-primary-light rounded-[--radius-card] p-4 flex items-center gap-3.5 shadow-2xs hover:shadow-xs transition-all">
                                                    <div className="w-10 h-10 rounded-[--radius-button] bg-brand-primary text-text-on-brand flex items-center justify-center shadow-xs shrink-0">
                                                        <Clock size={20} />
                                                    </div>
                                                    <div className="min-w-0">
                                                        <p className="text-xs text-text-muted font-bold tracking-wide uppercase">Scheduled Hours</p>
                                                        <p data-testid="shift-stat-hours" className="text-xl font-extrabold text-text-heading mt-0.5 truncate">{stats.totalHours}h</p>
                                                    </div>
                                                </div>
                                                
                                                <div className="bg-status-success-bg/30 border border-status-success/30 rounded-[--radius-card] p-4 flex items-center gap-3.5 shadow-2xs hover:shadow-xs transition-all">
                                                    <div className="w-10 h-10 rounded-[--radius-button] bg-status-success text-white flex items-center justify-center shadow-xs shrink-0">
                                                        <CalendarIcon size={20} />
                                                    </div>
                                                    <div className="min-w-0">
                                                        <p className="text-xs text-text-muted font-bold tracking-wide uppercase">Work Days</p>
                                                        <p data-testid="shift-stat-workdays" className="text-xl font-extrabold text-text-heading mt-0.5 truncate">{stats.totalShifts} days</p>
                                                    </div>
                                                </div>

                                                <div className="bg-status-warning-bg/30 border border-status-warning/30 rounded-[--radius-card] p-4 flex items-center gap-3.5 shadow-2xs hover:shadow-xs transition-all">
                                                    <div className="w-10 h-10 rounded-[--radius-button] bg-status-warning text-white flex items-center justify-center shadow-xs shrink-0">
                                                        <CalendarDays size={20} />
                                                    </div>
                                                    <div className="min-w-0">
                                                        <p className="text-xs text-text-muted font-bold tracking-wide uppercase">Leave Days</p>
                                                        <p data-testid="shift-stat-leaves" className="text-xl font-extrabold text-text-heading mt-0.5 truncate">{stats.totalLeaves} days</p>
                                                    </div>
                                                </div>

                                                <div className="bg-status-info-bg/30 border border-status-info/30 rounded-[--radius-card] p-4 flex items-center gap-3.5 shadow-2xs hover:shadow-xs transition-all">
                                                    <div className="w-10 h-10 rounded-[--radius-button] bg-status-info text-white flex items-center justify-center shadow-xs shrink-0">
                                                        <Clock size={20} />
                                                    </div>
                                                    <div className="min-w-0">
                                                        <p className="text-xs text-text-muted font-bold tracking-wide uppercase">Logged Overtime</p>
                                                        <p data-testid="shift-stat-overtime" className="text-xl font-extrabold text-text-heading mt-0.5 truncate">{stats.totalOvertimes}h</p>
                                                    </div>
                                                </div>
                                            </div>

                                            {/* Legend with improved styling */}
                                            <div className="flex items-center justify-between mb-6 p-4 bg-surface-page rounded-[--radius-card] border border-surface-border">
                                                <div className="flex items-center gap-6 flex-wrap">
                                                    <span className="text-xs font-bold text-text-muted uppercase tracking-wider">Legend:</span>
                                                    {[
                                                        { type: 'work', label: 'Work', color: 'bg-brand-primary', border: 'border-brand-primary-dark' },
                                                        { type: 'leave', label: 'On leave', color: 'bg-brand-accent', border: 'border-brand-accent-dark' },
                                                        { type: 'overtime', label: 'Overtime', color: 'bg-status-info', border: 'border-status-info' },
                                                        { type: 'holiday', label: 'Holiday', color: 'bg-status-error', border: 'border-status-error' },
                                                    ].map((item) => (
                                                        <div key={item.type} className="flex items-center gap-2">
                                                            <div className={`w-3.5 h-3.5 rounded-[--radius-button] ${item.color} border border-white shadow-xs`}></div>
                                                            <span className="text-sm text-text-body font-medium">{item.label}</span>
                                                        </div>
                                                    ))}
                                                </div>
                                                <div className="text-sm text-text-muted font-medium">
                                                    Showing <span data-testid="shift-count" className="font-bold text-text-heading">{workEvents.length}</span> shifts
                                                </div>
                                            </div>

                                            {/* FullCalendar with enhanced styling */}
                                            <div data-testid="shift-calendar" className="calendar-container">
                                                <FullCalendarView
                                                    events={fullCalendarEvents}
                                                    onEventClick={handleEventClick}
                                                    onDateSelect={handleDateSelect}
                                                    onDatesSet={handleDatesSet}
                                                    editable={true}
                                                    selectable={true}
                                                    initialView="timeGridWeek"
                                                    height={600}
                                                    headerToolbar={{
                                                        left: 'prev,next today',
                                                        center: 'title',
                                                        right: 'timeGridWeek,timeGridDay'
                                                    }}
                                                />
                                            </div>

                                            {/* Quick Tips */}
                                            {/*
                                              * The shift list exists so this screen can DELETE. The calendar
                                              * itself only opens the edit modal, so before this the only delete
                                              * control in the app lived on /dashboard/my-calendar — an admin
                                              * could create a shift here and had to go elsewhere to remove it.
                                              */}
                                            <div className="mt-6" data-testid="shift-list">
                                                <h4 className="text-sm font-bold text-text-heading mb-3">
                                                    Shifts in view
                                                </h4>
                                                {workEvents.length === 0 ? (
                                                    <p data-testid="shift-list-empty" className="text-sm text-text-muted">
                                                        No shifts scheduled in the visible range.
                                                    </p>
                                                ) : (
                                                    <ul className="divide-y divide-surface-border border border-surface-border rounded-[--radius-card] overflow-hidden">
                                                        {workEvents.map((event) => (
                                                            <li
                                                                key={event.id}
                                                                data-testid={`shift-row-${event.id}`}
                                                                className="flex items-center justify-between gap-3 px-4 py-2.5 bg-surface-card"
                                                            >
                                                                <div className="min-w-0">
                                                                    <p className="text-sm font-semibold text-text-heading truncate">
                                                                        {event.title}
                                                                    </p>
                                                                    <p className="text-[11px] text-text-muted font-medium">
                                                                        {toCalendarDate(new Date(event.startDate))}
                                                                    </p>
                                                                </div>
                                                                <div className="flex items-center gap-2 shrink-0">
                                                                    {can('EDIT_SCHEDULE') && (
                                                                        <button
                                                                            type="button"
                                                                            data-testid={`shift-edit-${event.id}`}
                                                                            onClick={() => {
                                                                                setSelectedScheduleId(event.id);
                                                                                setIsScheduleModalOpen(true);
                                                                            }}
                                                                            className="px-3 py-1.5 text-xs font-semibold border border-surface-border rounded-[--radius-button] hover:bg-surface-page text-text-body transition-colors cursor-pointer"
                                                                        >
                                                                            Edit
                                                                        </button>
                                                                    )}
                                                                    {can('DELETE_SCHEDULE') && (
                                                                        <button
                                                                            type="button"
                                                                            data-testid={`shift-delete-${event.id}`}
                                                                            disabled={deletingId === event.id}
                                                                            onClick={() => handleDeleteSchedule(event.id)}
                                                                            className="px-3 py-1.5 text-xs font-semibold border border-status-error/30 text-status-error rounded-[--radius-button] hover:bg-status-error-bg/40 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                                                                        >
                                                                            {deletingId === event.id ? 'Deleting...' : 'Delete'}
                                                                        </button>
                                                                    )}
                                                                </div>
                                                            </li>
                                                        ))}
                                                    </ul>
                                                )}
                                            </div>

                                            <div className="mt-6 p-4 bg-status-info-bg/40 border border-status-info/20 rounded-[--radius-card]">
                                                <div className="flex items-start gap-3">
                                                    <CalendarIcon size={20} className="text-status-info mt-0.5 flex-shrink-0" />
                                                    <div className="text-sm text-text-body">
                                                        <p className="font-semibold mb-1 text-text-heading">Usage tips:</p>
                                                        <ul className="space-y-1 text-text-body/90">
                                                            <li>• Click on the shift to edit</li>
                                                            <li>• Click on an empty box to quickly create a new shift</li>
                                                            <li>• Drag and drop to change time (coming soon)</li>
                                                        </ul>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    </>
                                ) : (
                                    <div data-testid="shift-no-selection" className="text-center py-24">
                                        <div className="w-20 h-20 rounded-full bg-surface-page flex items-center justify-center mx-auto mb-4">
                                            <Users size={40} className="text-text-muted" />
                                        </div>
                                        <h3 className="text-lg font-semibold text-text-heading mb-2">Select employee</h3>
                                        <p className="text-text-muted">Select employees from the list on the left to view and manage work schedules</p>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Schedule Modal */}
                    <ScheduleModal
                        isOpen={isScheduleModalOpen}
                        onClose={() => setIsScheduleModalOpen(false)}
                        onSuccess={handleScheduleSuccess}
                        scheduleId={selectedScheduleId}
                        initialDate={selectedDate || undefined}
                        employeeId={selectedEmployee}
                    />

                    {/* Bulk Schedule Modal */}
                    <BulkScheduleModal
                        isOpen={isBulkScheduleModalOpen}
                        onClose={() => setIsBulkScheduleModalOpen(false)}
                        onSuccess={handleScheduleSuccess}
                    />
                </div>

                <style jsx global>{`
                .custom-scrollbar::-webkit-scrollbar {
                    width: 6px;
                }
                .custom-scrollbar::-webkit-scrollbar-track {
                    background: var(--color-surface-border-light);
                    border-radius: 3px;
                }
                .custom-scrollbar::-webkit-scrollbar-thumb {
                    background: var(--color-brand-primary-light);
                    border-radius: 3px;
                }
                .custom-scrollbar::-webkit-scrollbar-thumb:hover {
                    background: var(--color-brand-primary);
                }
                
                .calendar-container .fc {
                    border-radius: var(--radius-card);
                    overflow: hidden;
                }
                
                .calendar-container .fc-timegrid-slot {
                    height: 2.5rem;
                }
                
                .calendar-container .fc-col-header-cell {
                    background: linear-gradient(to bottom, var(--color-surface-page), var(--color-surface-border-light));
                    font-weight: 700;
                    padding: 1rem 0;
                }
                
                .calendar-container .fc-timegrid-axis {
                    background: var(--color-surface-page);
                }
                
                .calendar-container .fc-event {
                    border-width: 2px;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.2s;
                }
                
                .calendar-container .fc-event:hover {
                    transform: translateY(-1px);
                    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
                }
            `}</style>
            </>
        </ProtectedRoute>
    );
}

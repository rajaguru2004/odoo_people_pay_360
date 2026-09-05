'use client';

import { useEffect, useState } from 'react';
import { getCompanyTz } from '@/utils/formatters';
import { Clock, Briefcase, Umbrella, Award, Plus, Edit, Trash2, Users, Calendar } from 'lucide-react';
import { motion } from 'framer-motion';
import { EventClickArg, DateSelectArg } from '@fullcalendar/core';
import calendarService from '@/services/calendarService';
import { CalendarEvent, CalendarStats } from '@/types/calendar';
import ScheduleModal from '@/components/calendar/ScheduleModal';
import BulkScheduleModal from '@/components/calendar/BulkScheduleModal';
import FullCalendarView from '@/components/calendar/FullCalendarView';

// RBAC
import { usePermission } from '@/hooks/usePermission';
import { usePageHeader } from '@/hooks/usePageHeader';
import { apiErrorMessage } from '@/utils/apiError';
import { toCalendarDate } from '@/utils/scheduleHours';

export default function MyCalendarPage() {
    const { can } = usePermission();

    // The one heading for this route, rendered by TopHeader.
    usePageHeader('Work schedule', 'View and organize your work shifts, vacations, and overtime schedules');

    const [currentDate, setCurrentDate] = useState(new Date());
    const [visibleRange, setVisibleRange] = useState<{ start: Date; end: Date } | null>(null);
    const [events, setEvents] = useState<CalendarEvent[]>([]);
    const [stats, setStats] = useState<CalendarStats>({
        workDays: 0,
        leaveDays: 0,
        overtimeHours: 0,
        holidays: 0,
    });
    const [loading, setLoading] = useState(false);
    const [selectedDate, setSelectedDate] = useState<Date | null>(null);
    const [isScheduleModalOpen, setIsScheduleModalOpen] = useState(false);
    const [isBulkScheduleModalOpen, setIsBulkScheduleModalOpen] = useState(false);
    const [selectedScheduleId, setSelectedScheduleId] = useState<string | undefined>();
    /**
     * Three slots, not one — the same reason the schedule overview needs two.
     *
     * This screen runs two independent loaders (the month's stats and the
     * visible range's events) and one user action (delete). A single shared slot
     * makes the banner depend on which finished LAST: a failed load followed by
     * a successful one clears the message and the screen goes back to looking
     * merely quiet, which is the exact failure mode T20 is about.
     *
     * The action takes precedence when reading, because it is the thing the user
     * just did and expects an answer to.
     */
    const [statsError, setStatsError] = useState<string | null>(null);
    const [eventsError, setEventsError] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const error = actionError ?? eventsError ?? statsError;

    const currentMonth = currentDate.getMonth();
    const currentYear = currentDate.getFullYear();

    // Initial stats fetch (by current month)
    useEffect(() => {
        fetchStats();
    }, [currentMonth, currentYear]);

    const fetchStats = async () => {
        try {
            setStatsError(null);
            const statsRes = await calendarService.getCalendarStats(currentMonth + 1, currentYear);
            setStats(statsRes.data);
        } catch (err) {
            // Surfaced rather than swallowed: the tiles fall back to zeroes, and
            // "you worked 0 days this month" is a claim, not an absence of one.
            console.error('Error loading statistics:', err);
            setStatsError(apiErrorMessage(err, 'Could not load this month\'s totals.'));
        }
    };

    // Called by FullCalendar whenever the visible date range changes (view switch, prev/next navigation)
    const handleDatesSet = async (start: Date, end: Date) => {
        setCurrentDate(start);
        setVisibleRange({ start, end });
        try {
            setLoading(true);
            setEventsError(null);
            const eventsRes = await calendarService.getMyCalendar(
                toCalendarDate(start),
                // FullCalendar end is exclusive, subtract 1 day
                toCalendarDate(new Date(end.getTime() - 86400000))
            );
            setEvents(eventsRes.data ?? []);
        } catch (err) {
            // An empty calendar and a refused one are the same picture without
            // this, and the user has no way to tell which they are looking at.
            console.error('Error loading calendar:', err);
            setEvents([]);
            setEventsError(apiErrorMessage(err, 'Could not load your calendar.'));
        } finally {
            setLoading(false);
        }
    };

    const fetchCalendarData = async () => {
        if (!visibleRange) return;
        await handleDatesSet(visibleRange.start, visibleRange.end);
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
        if (event && can('EDIT_SCHEDULE') && event.type === 'work') {
            setSelectedScheduleId(event.id);
            setIsScheduleModalOpen(true);
        }
    };

    /**
     * A day was clicked or dragged over.
     *
     * Selects the day and NOTHING else. It used to open the create modal too,
     * and that quietly cost schedulers the whole day-detail panel: FullCalendar
     * is mounted `selectable` for anyone holding `CREATE_SCHEDULE`, so their
     * click is consumed as a range select and fired `select` — which meant the
     * modal opened over a panel that had only just been asked to render, and
     * closing it left `selectedDate` set but the user back at the grid.
     *
     * The effect was that the two roles allowed to edit and delete a shift could
     * never reach the controls that do it, because those controls live only in
     * that panel — while the two roles that could open the panel were not
     * allowed to use them. Nobody could reach a working combination.
     *
     * Creating is still one click away and now says so: the panel carries its
     * own "Add schedule" button, pre-filled with the day just selected, and the
     * header button covers the case where no day is chosen yet.
     */
    const handleDateSelect = (info: DateSelectArg) => {
        setSelectedDate(info.start);
    };

    const handleDateClick = (date: Date) => {
        setSelectedDate(date);
    };

    const handleCreateSchedule = (date?: Date) => {
        setSelectedScheduleId(undefined);
        setSelectedDate(date || null);
        setIsScheduleModalOpen(true);
    };

    const handleEditSchedule = (scheduleId: string) => {
        setSelectedScheduleId(scheduleId);
        setIsScheduleModalOpen(true);
    };

    const handleDeleteSchedule = async (scheduleId: string) => {
        if (!confirm('Are you sure you want to delete this calendar?')) return;

        try {
            // Cleared on the way IN, not on success: a stale "could not delete"
            // sitting above a list where the delete plainly worked is its own
            // small lie.
            setActionError(null);
            await calendarService.deleteSchedule(scheduleId);
            fetchCalendarData();
        } catch (err) {
            console.error('Error when deleting work schedule:', err);
            setActionError(apiErrorMessage(err, 'An error occurred while deleting the work schedule'));
        }
    };

    const handleScheduleSuccess = () => {
        fetchCalendarData();
    };

    const getEventsForDate = (date: Date) => {
        return events.filter(event => {
            const eventStart = new Date(event.startDate);
            const eventEnd = new Date(event.endDate);
            const checkDate = new Date(date);
            checkDate.setHours(0, 0, 0, 0);
            eventStart.setHours(0, 0, 0, 0);
            eventEnd.setHours(0, 0, 0, 0);
            return checkDate >= eventStart && checkDate <= eventEnd;
        });
    };

    const getEventColor = (type: string) => {
        const colors = {
            work: 'bg-brand-primary',
            leave: 'bg-brand-accent',
            overtime: 'bg-status-info',
            holiday: 'bg-status-error',
        };
        return colors[type as keyof typeof colors] || 'bg-text-muted';
    };

    const isToday = (date: Date) => {
        const today = new Date();
        return date.getDate() === today.getDate() &&
            date.getMonth() === today.getMonth() &&
            date.getFullYear() === today.getFullYear();
    };

    const formatSelectedDate = (date: Date) => {
        return date.toLocaleDateString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
    };

    const monthNames = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'
    ];

    const dayNames = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

    return (
        <>
            <div className="space-y-4 sm:space-y-5 max-w-7xl mx-auto" data-testid="ess-my-calendar">
                {/* The title/subtitle live in the sticky TopHeader, declared via
                    usePageHeader above. The "My Work Hub" pill went with them —
                    it labelled that heading and has nothing to sit beside now. */}

                {/* Quick Stats */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                    {[
                        {
                            key: 'workdays',
                            label: 'Workdays',
                            value: stats.workDays,
                            icon: Briefcase,
                            accentColor: 'bg-brand-primary/10 text-brand-primary',
                        },
                        {
                            key: 'leaves',
                            label: 'Vacation days',
                            value: stats.leaveDays,
                            icon: Umbrella,
                            accentColor: 'bg-brand-accent/10 text-brand-accent',
                        },
                        {
                            key: 'overtime',
                            label: 'Overtime hours',
                            value: `${stats.overtimeHours}h`,
                            icon: Clock,
                            accentColor: 'bg-status-info-bg text-status-info',
                        },
                        {
                            key: 'holidays',
                            label: 'Holidays',
                            value: stats.holidays,
                            icon: Award,
                            accentColor: 'bg-status-error-bg text-status-error',
                        },
                    ].map((stat, index) => {
                        const Icon = stat.icon;
                        return (
                            <motion.div
                                key={stat.label}
                                data-testid={`mycal-stat-${stat.key}`}
                                initial={{ opacity: 0, y: 20 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ delay: index * 0.1, ease: 'easeOut' }}
                                className="bg-surface-card rounded-xl p-3 sm:p-4 border border-surface-border shadow-sm cursor-default"
                            >
                                <div className="flex items-center gap-2 mb-2 min-w-0">
                                    <div className={`w-8 h-8 shrink-0 ${stat.accentColor} rounded-lg flex items-center justify-center`}>
                                        <Icon size={16} />
                                    </div>
                                    <span className="text-[11px] uppercase tracking-wide text-text-muted font-medium truncate">{stat.label}</span>
                                </div>
                                <p className="text-xl sm:text-2xl font-semibold tabular-nums text-text-heading">{stat.value}</p>
                            </motion.div>
                        );
                    })}
                </div>

                {error && (

                    <div

                        data-testid="mycal-error"

                        role="alert"

                        className="bg-status-error-bg/40 border border-status-error/30 text-status-error rounded-xl px-4 py-3 text-sm font-medium"

                    >

                        {error}

                    </div>

                )}


                {/* Calendar */}
                <div className="bg-surface-card rounded-xl border border-surface-border shadow-sm p-4 sm:p-5">
                    {/* Calendar Header */}
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4 pb-4 border-b border-surface-border-light">
                        <div>
                            <h2 className="text-sm sm:text-base font-semibold text-text-heading flex items-center gap-2">
                                <Calendar size={18} className="text-brand-primary" />
                                My work schedule
                            </h2>
                            <p className="text-text-muted text-xs mt-0.5">Manage and track your daily shifts and request statuses</p>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                            {can('CREATE_SCHEDULE') && (
                                <>
                                    <button
                                        data-testid="mycal-bulk-create"
                                        onClick={() => setIsBulkScheduleModalOpen(true)}
                                        className="inline-flex items-center justify-center gap-2 min-w-11 h-9 px-3 rounded-lg bg-brand-accent hover:bg-brand-accent-dark text-text-on-accent text-sm font-medium transition-colors cursor-pointer touch-manipulation"
                                    >
                                        <Users size={16} />
                                        Create in bulk
                                    </button>
                                    <button
                                        data-testid="mycal-create"
                                        onClick={() => handleCreateSchedule()}
                                        className="inline-flex items-center justify-center gap-2 min-w-11 h-9 px-3 rounded-lg bg-brand-primary hover:bg-brand-primary-dark text-text-on-brand text-sm font-medium transition-colors cursor-pointer touch-manipulation"
                                    >
                                        <Plus size={16} />
                                        Create schedule
                                    </button>
                                </>
                            )}
                        </div>
                    </div>

                    {/* Legend */}
                    <div className="flex items-center gap-2 mb-4 flex-wrap">
                        {[
                            { type: 'work', label: 'Work Schedule', bg: 'bg-brand-primary-light/10 border-brand-primary-light/30', dot: 'bg-brand-primary', text: 'text-brand-primary' },
                            { type: 'leave', label: 'On Leave', bg: 'bg-status-warning-bg/30 border-status-warning/20', dot: 'bg-brand-accent', text: 'text-brand-accent' },
                            { type: 'overtime', label: 'Overtime', bg: 'bg-status-info-bg/30 border-status-info/20', dot: 'bg-status-info', text: 'text-status-info' },
                            { type: 'holiday', label: 'Holiday', bg: 'bg-status-error-bg/30 border-status-error/20', dot: 'bg-status-error', text: 'text-status-error' },
                        ].map((item) => (
                            <div
                                key={item.type}
                                className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border ${item.bg} text-[11px] font-medium ${item.text} cursor-default`}
                            >
                                <div className={`w-2 h-2 rounded-full ${item.dot}`}></div>
                                <span>{item.label}</span>
                            </div>
                        ))}
                    </div>

                    {/* FullCalendar - always rendered, datesSet drives data loading */}
                    <div className="relative">
                        {loading && (
                            <div className="absolute inset-0 bg-surface-card/60 flex items-center justify-center z-10 rounded-xl">
                                <div className="w-8 h-8 border-4 border-brand-primary border-t-transparent rounded-full animate-spin"></div>
                            </div>
                        )}
                        {/*
                            D-02. This was the one screen still branching its
                            LAYOUT on `useIsMobile()`, and the hook returns
                            false on the first client render — so every phone
                            load painted the month grid, then remounted the
                            whole calendar (the `key` forced it) into the list
                            view. FullCalendar takes `initialView` and
                            `headerToolbar` as props, so unlike every other
                            screen this genuinely cannot be one responsive
                            tree; it is two instances behind the same CSS split
                            the rest of the pass uses, with no hook and no
                            remount. The month grid's four view buttons plus a
                            title and prev/next do not fit 390px, which is why
                            the phone toolbar is three controls.
                        */}
                        <div className="md:hidden">
                            <FullCalendarView
                                events={fullCalendarEvents}
                                onEventClick={handleEventClick}
                                onDateSelect={handleDateSelect}
                                onDateClick={handleDateClick}
                                onDatesSet={handleDatesSet}
                                editable={can('EDIT_SCHEDULE')}
                                selectable={can('CREATE_SCHEDULE')}
                                initialView="listWeek"
                                headerToolbar={{ left: 'prev,next', center: 'title', right: 'today' }}
                                height="auto"
                            />
                        </div>
                        <div className="hidden md:block">
                            <FullCalendarView
                                events={fullCalendarEvents}
                                onEventClick={handleEventClick}
                                onDateSelect={handleDateSelect}
                                onDateClick={handleDateClick}
                                onDatesSet={handleDatesSet}
                                editable={can('EDIT_SCHEDULE')}
                                selectable={can('CREATE_SCHEDULE')}
                                initialView="dayGridMonth"
                                headerToolbar={{ left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek,timeGridDay,listWeek' }}
                                height="auto"
                            />
                        </div>
                    </div>
                </div>

                {/* Selected Date Events */}
                {selectedDate && (
                    <motion.div 
                        initial={{ opacity: 0, y: 15 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="bg-surface-card rounded-xl p-4 sm:p-5 border border-surface-border shadow-sm"
                    >
                        <div className="flex items-center justify-between gap-2 mb-4 pb-3 border-b border-surface-border-light">
                            <div className="min-w-0">
                                <h3 className="text-sm sm:text-base font-semibold text-text-heading">
                                    Events for {formatSelectedDate(selectedDate)}
                                </h3>
                                <p className="text-text-muted text-xs mt-0.5">Details of events scheduled for this day</p>
                            </div>
                            {can('CREATE_SCHEDULE') && (
                                <button
                                    data-testid="mycal-day-add"
                                    onClick={() => handleCreateSchedule(selectedDate)}
                                    className="inline-flex items-center justify-center gap-1.5 h-11 md:h-9 px-3 shrink-0 rounded-lg bg-brand-primary hover:bg-brand-primary-dark text-text-on-brand text-xs font-medium transition-colors cursor-pointer"
                                >
                                    <Plus size={14} />
                                    Add schedule
                                </button>
                            )}
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4">
                            {getEventsForDate(selectedDate).map((event) => {
                                const isWork = event.type === 'work';
                                const isLeave = event.type === 'leave';
                                const isOvertime = event.type === 'overtime';
                                const isHoliday = event.type === 'holiday';
                                
                                const cardBgClass = isWork 
                                    ? 'bg-brand-primary-light/10 hover:bg-brand-primary-light/20 border-brand-primary-light text-brand-primary'
                                    : isLeave
                                    ? 'bg-status-warning-bg/30 hover:bg-status-warning-bg/40 border-status-warning/20 text-brand-accent'
                                    : isOvertime
                                    ? 'bg-status-info-bg/30 hover:bg-status-info-bg/40 border-status-info/20 text-status-info'
                                    : 'bg-status-error-bg/30 hover:bg-status-error-bg/40 border-status-error/20 text-status-error';
                                    
                                const dotColor = isWork
                                    ? 'bg-brand-primary'
                                    : isLeave
                                    ? 'bg-brand-accent'
                                    : isOvertime
                                    ? 'bg-status-info'
                                    : 'bg-status-error';

                                return (
                                    <div
                                        key={event.id}
                                        data-testid={`mycal-event-${event.id}`}
                                        data-event-type={event.type}
                                        className={`flex items-start gap-3 p-3 rounded-lg border transition-colors ${cardBgClass}`}
                                    >
                                        <div className={`w-2.5 h-2.5 rounded-full mt-1.5 ${dotColor} shrink-0`}></div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-semibold text-text-heading truncate">{event.title}</p>
                                            {event.description && (
                                                <p className="text-xs text-text-body mt-1 line-clamp-2">{event.description}</p>
                                            )}
                                            <p className="text-xs text-text-muted font-medium mt-1.5 flex items-center gap-1">
                                                <Clock size={12} />
                                                <span>
                                                    {event.allDay ? 'All day' : `${new Date(event.startDate).toLocaleTimeString('en-IN', { timeZone: getCompanyTz(),  hour: '2-digit', minute: '2-digit' })} - ${new Date(event.endDate).toLocaleTimeString('en-IN', { timeZone: getCompanyTz(),  hour: '2-digit', minute: '2-digit' })}`}
                                                </span>
                                            </p>
                                        </div>
                                        {(can('EDIT_SCHEDULE') || can('DELETE_SCHEDULE')) && event.type === 'work' && (
                                            <div className="flex items-center gap-1 shrink-0 ms-1">
                                                {can('EDIT_SCHEDULE') && (
                                                <button
                                                    data-testid={`mycal-edit-${event.id}`}
                                                    onClick={() => handleEditSchedule(event.id)}
                                                    className="p-1.5 text-text-muted hover:text-brand-primary hover:bg-surface-page rounded-lg transition-colors cursor-pointer"
                                                    title="Edit"
                                                >
                                                    <Edit size={15} />
                                                </button>
                                                )}
                                                {can('DELETE_SCHEDULE') && (
                                                <button
                                                    data-testid={`mycal-delete-${event.id}`}
                                                    onClick={() => handleDeleteSchedule(event.id)}
                                                    className="p-1.5 text-text-muted hover:text-status-error hover:bg-surface-page rounded-lg transition-colors cursor-pointer"
                                                    title="Delete"
                                                >
                                                    <Trash2 size={15} />
                                                </button>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                );
                             })}
                            {getEventsForDate(selectedDate).length === 0 && (
                                <div data-testid="mycal-empty" className="col-span-full flex flex-col items-center justify-center py-8 px-4 text-center border border-dashed border-surface-border rounded-xl bg-surface-page/50">
                                    <Calendar size={20} className="text-text-muted mb-2" />
                                    <p className="text-text-muted font-medium text-sm">No events scheduled for this day</p>
                                    <p className="text-text-muted text-xs mt-0.5">Click "Add schedule" or select days above to schedule.</p>
                                </div>
                            )}
                        </div>
                    </motion.div>
                )}

                {/* Schedule Modal */}
                <ScheduleModal
                    isOpen={isScheduleModalOpen}
                    onClose={() => setIsScheduleModalOpen(false)}
                    onSuccess={handleScheduleSuccess}
                    scheduleId={selectedScheduleId}
                    initialDate={selectedDate || undefined}
                />

                {/* Bulk Schedule Modal */}
                <BulkScheduleModal
                    isOpen={isBulkScheduleModalOpen}
                    onClose={() => setIsBulkScheduleModalOpen(false)}
                    onSuccess={handleScheduleSuccess}
                />
            </div>
        </>
    );
}

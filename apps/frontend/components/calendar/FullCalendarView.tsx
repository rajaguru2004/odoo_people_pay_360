'use client';

import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import listPlugin from '@fullcalendar/list';
import { EventClickArg, DateSelectArg, EventInput, DatesSetArg } from '@fullcalendar/core';

interface FullCalendarViewProps {
    events: EventInput[];
    onEventClick?: (info: EventClickArg) => void;
    onDateSelect?: (info: DateSelectArg) => void;
    onDateClick?: (date: Date) => void;
    onDatesSet?: (start: Date, end: Date) => void;
    editable?: boolean;
    selectable?: boolean;
    initialView?: 'dayGridMonth' | 'timeGridWeek' | 'timeGridDay' | 'listWeek';
    height?: string | number;
    headerToolbar?: {
        left?: string;
        center?: string;
        right?: string;
    };
}

export default function FullCalendarView({
    events,
    onEventClick,
    onDateSelect,
    onDateClick,
    onDatesSet,
    editable = false,
    selectable = true,
    initialView = 'dayGridMonth',
    height = 'auto',
    headerToolbar = {
        left: 'prev,next today',
        center: 'title',
        right: 'dayGridMonth,timeGridWeek,timeGridDay,listWeek'
    }
}: FullCalendarViewProps) {
    return (
        <div className="fullcalendar-wrapper">
            <FullCalendar
                plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin, listPlugin]}
                initialView={initialView}
                headerToolbar={headerToolbar}
                locale="en"
                events={events}
                eventClick={onEventClick}
                select={onDateSelect}
                dateClick={(info) => onDateClick?.(info.date)}
                datesSet={(arg: DatesSetArg) => onDatesSet?.(arg.start, arg.end)}
                editable={editable}
                selectable={selectable}
                selectMirror={true}
                dayMaxEvents={3}
                weekends={true}
                height={height}
                slotMinTime="06:00:00"
                slotMaxTime="22:00:00"
                slotDuration="01:00:00"
                allDaySlot={true}
                allDayText="All day"
                nowIndicator={true}
                eventTimeFormat={{
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false
                }}
                slotLabelFormat={{
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false
                }}
                buttonText={{
                    today: 'Today',
                    month: 'Month',
                    week: 'Week',
                    day: 'Day',
                    list: 'List'
                }}
                eventClassNames={(arg) => {
                    const type = arg.event.extendedProps.type;
                    return [`fc-event-${type}`];
                }}
            />
            <style jsx global>{`
                .fullcalendar-wrapper {
                    --fc-border-color: var(--color-surface-border-light);
                    --fc-button-bg-color: var(--color-surface-card);
                    --fc-button-border-color: var(--color-surface-border);
                    --fc-button-text-color: var(--color-text-body);
                    --fc-button-hover-bg-color: var(--color-surface-page);
                    --fc-button-hover-border-color: var(--color-surface-border);
                    --fc-button-active-bg-color: var(--color-surface-border-light);
                    --fc-button-active-border-color: var(--color-text-muted);
                    --fc-today-bg-color: var(--color-brand-primary-light);
                }

                .fc {
                    font-family: inherit;
                }

                .fc-toolbar {
                    margin-bottom: 1.5rem !important;
                    flex-wrap: wrap;
                    gap: 0.75rem;
                }

                .fc-toolbar-chunk {
                    display: flex !important;
                    align-items: center !important;
                    gap: 0.5rem !important;
                }

                .fc-button-group {
                    gap: 0.375rem !important;
                }

                .fc-button-group > .fc-button {
                    border-radius: var(--radius-button) !important;
                    margin-left: 0 !important;
                    margin-right: 0 !important;
                }

                .fc-toolbar-title {
                    font-size: 1.25rem !important;
                    font-weight: 800 !important;
                    letter-spacing: -0.02em !important;
                    color: var(--color-text-heading);
                }

                .fc-button {
                    text-transform: none !important;
                    font-weight: 500 !important;
                    font-size: 0.875rem !important;
                    padding: 0.5rem 0.875rem !important;
                    border-radius: var(--radius-button) !important;
                    transition: all 0.2s ease !important;
                    box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05) !important;
                    background-color: var(--fc-button-bg-color) !important;
                    border: 1px solid var(--fc-button-border-color) !important;
                    color: var(--fc-button-text-color) !important;
                }

                .fc-button:hover {
                    background-color: var(--fc-button-hover-bg-color) !important;
                    border-color: var(--fc-button-hover-border-color) !important;
                    color: var(--color-text-heading) !important;
                }

                .fc-button:focus {
                    box-shadow: 0 0 0 2px var(--color-brand-primary-light) !important;
                }

                .fc-button-active,
                .fc-button-primary:not(:disabled).fc-button-active,
                .fc-button-primary:not(:disabled):active {
                    background-color: var(--fc-button-active-bg-color) !important;
                    border-color: var(--fc-button-active-border-color) !important;
                    color: var(--color-text-heading) !important;
                    font-weight: 600 !important;
                    box-shadow: inset 0 1px 2px 0 rgba(0, 0, 0, 0.05) !important;
                }

                .fc-daygrid-day {
                    transition: background-color 0.2s ease;
                }

                .fc-daygrid-day:hover {
                    background-color: var(--color-surface-page);
                }

                .fc-daygrid-day-number {
                    font-size: 0.875rem !important;
                    font-weight: 600 !important;
                    color: var(--color-text-muted);
                    padding: 8px 10px !important;
                }

                .fc-day-today {
                    background-color: var(--fc-today-bg-color) !important;
                }

                .fc-day-today .fc-daygrid-day-number {
                    color: var(--color-brand-primary) !important;
                    font-weight: 700 !important;
                }

                .fc-col-header-cell {
                    background-color: var(--color-surface-page);
                    border-bottom: 2px solid var(--color-surface-border) !important;
                }

                .fc-col-header-cell-cushion {
                    font-size: 0.75rem !important;
                    font-weight: 700 !important;
                    letter-spacing: 0.05em !important;
                    text-transform: uppercase !important;
                    color: var(--color-text-muted) !important;
                    padding: 0.75rem 0 !important;
                    display: inline-block !important;
                }

                /* Custom event pills - sleek layout */
                .fc-event {
                    cursor: pointer;
                    border-radius: var(--radius-button) !important;
                    padding: 3px 6px !important;
                    font-size: 0.775rem !important;
                    font-weight: 600 !important;
                    margin: 2px 4px !important;
                    box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.02) !important;
                    transition: transform 0.15s ease, box-shadow 0.15s ease !important;
                }

                .fc-event:hover {
                    transform: translateY(-0.5px) scale(1.01);
                    box-shadow: 0 2px 4px 0 rgba(0, 0, 0, 0.05) !important;
                    opacity: 1 !important;
                }

                /* Event colors by type */
                .fc-event-work {
                    background-color: var(--color-brand-primary-light) !important;
                    border-left: 3px solid var(--color-brand-primary) !important;
                    border-top: none !important;
                    border-right: none !important;
                    border-bottom: none !important;
                    color: var(--color-brand-primary-dark) !important;
                }

                .fc-event-work .fc-event-main,
                .fc-event-work .fc-event-title,
                .fc-event-work .fc-event-time,
                .fc-event-work a {
                    color: var(--color-brand-primary-dark) !important;
                }

                .fc-event-leave {
                    background-color: var(--color-status-warning-bg) !important;
                    border-left: 3px solid var(--color-brand-accent) !important;
                    border-top: none !important;
                    border-right: none !important;
                    border-bottom: none !important;
                    color: var(--color-brand-accent-dark) !important;
                }

                .fc-event-leave .fc-event-main,
                .fc-event-leave .fc-event-title,
                .fc-event-leave .fc-event-time,
                .fc-event-leave a {
                    color: var(--color-brand-accent-dark) !important;
                }

                .fc-event-overtime {
                    background-color: var(--color-status-info-bg) !important;
                    border-left: 3px solid var(--color-status-info) !important;
                    border-top: none !important;
                    border-right: none !important;
                    border-bottom: none !important;
                    color: var(--color-status-info) !important;
                }

                .fc-event-overtime .fc-event-main,
                .fc-event-overtime .fc-event-title,
                .fc-event-overtime .fc-event-time,
                .fc-event-overtime a {
                    color: var(--color-status-info) !important;
                }

                .fc-event-holiday {
                    background-color: var(--color-status-error-bg) !important;
                    border-left: 3px solid var(--color-status-error) !important;
                    border-top: none !important;
                    border-right: none !important;
                    border-bottom: none !important;
                    color: var(--color-status-error) !important;
                }

                .fc-event-holiday .fc-event-main,
                .fc-event-holiday .fc-event-title,
                .fc-event-holiday .fc-event-time,
                .fc-event-holiday a {
                    color: var(--color-status-error) !important;
                }

                .fc-daygrid-event {
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }

                .fc-timegrid-event {
                    border-radius: var(--radius-button);
                }

                .fc-list-event:hover td {
                    background-color: var(--color-surface-page);
                }

                .fc-scrollgrid {
                    border-radius: var(--radius-card);
                    overflow: hidden;
                    border: 1px solid var(--color-surface-border) !important;
                }

                .fc-theme-standard td, .fc-theme-standard th {
                    border: 1px solid var(--color-surface-border-light) !important;
                }
                
                .fc-list {
                    border-radius: var(--radius-card);
                    overflow: hidden;
                    border: 1px solid var(--color-surface-border) !important;
                }

                .fc-list-day-side {
                    color: var(--color-text-muted) !important;
                    font-weight: 600 !important;
                }

                .fc-list-day-text {
                    font-weight: 700 !important;
                    color: var(--color-text-heading) !important;
                }

                /* ── Mobile: shrink toolbar + grid so the calendar fits a phone ── */
                @media (max-width: 640px) {
                    .fc .fc-toolbar.fc-header-toolbar {
                        margin-bottom: 1rem !important;
                    }
                    .fc-toolbar-title {
                        font-size: 1rem !important;
                    }
                    .fc-button {
                        padding: 0.375rem 0.625rem !important;
                        font-size: 0.8125rem !important;
                    }
                    .fc-col-header-cell-cushion {
                        padding: 0.5rem 0 !important;
                        font-size: 0.65rem !important;
                    }
                    .fc-daygrid-day-number {
                        padding: 4px 6px !important;
                        font-size: 0.8125rem !important;
                    }
                    .fc-event {
                        font-size: 0.7rem !important;
                        padding: 2px 4px !important;
                    }
                }
            `}</style>
        </div>
    );
}

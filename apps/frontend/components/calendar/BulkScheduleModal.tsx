'use client';

import { useState, useEffect, useMemo } from 'react';
import { X, Calendar, Clock, Users, AlertCircle, CheckCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import calendarService from '@/services/calendarService';
import employeeService from '@/services/employeeService';
import { apiErrorMessage } from '@/utils/apiError';
import { datesBetween, parseWeeklyOffDays, toCalendarDate } from '@/utils/scheduleHours';
import { ShiftType, BulkScheduleItem } from '@/types/calendar';
import { useBrandingStore } from '@/store/brandingStore';
import { useBranchStore } from '@/store/branchStore';
import { useBranches } from '@/hooks/useBranches';
import { buildUTCFromLocal } from '@/utils/tzDate';

interface BulkScheduleModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSuccess: () => void;
}

/**
 * The rest days assumed when the branch in context has not named its own.
 *
 * A LAST resort, not the default: `Branch.weeklyOffDays` decides the week
 * wherever it is set. Muscat rests Friday and Saturday and WORKS Sunday, so a
 * hard-coded Sat/Sun here rostered every employee on a rest day and left every
 * Sunday unrostered — a whole roster wrong, reported as a success.
 */
const DEFAULT_SKIPPED_DAYS = [0, 6];

interface Employee {
    id: string;
    employeeCode: string;
    fullName: string;
    status: string;
    contracts?: {
        id: string;
        startDate: string;
        endDate?: string | null;
    }[];
}

export default function BulkScheduleModal({ isOpen, onClose, onSuccess }: BulkScheduleModalProps) {
    const { branding } = useBrandingStore();
    const officeStart = branding?.office_start_time || '08:30';
    const officeEnd = branding?.office_end_time || '17:30';
    const defaultRequiredHours = Number(branding?.payroll_work_hours_per_day) || 8;

    // Which days THIS branch rests. Only ADMIN/HR_MANAGER can reach this modal
    // (`BULK_CREATE_SCHEDULES`), and both may switch branches, so the header's
    // selection is the branch being rostered.
    const selectedBranchId = useBranchStore((s) => s.selectedBranchId);
    // The same query key the header's BranchPicker already fills, so for an
    // admin this is a cache read rather than a second request. Asked only while
    // the modal is open — the list is not needed to render a closed dialog.
    const { data: branchList } = useBranches(isOpen && !!selectedBranchId);
    const branchSkippedDays = useMemo(() => {
        const branch = (branchList?.data ?? []).find((b) => b.id === selectedBranchId);
        // `parseWeeklyOffDays` already answers the fallback for a branch with a
        // blank or unparseable week, which is exactly the rule wanted here.
        return parseWeeklyOffDays(branch?.weeklyOffDays, DEFAULT_SKIPPED_DAYS);
    }, [branchList, selectedBranchId]);

    const [loading, setLoading] = useState(false);
    const [employees, setEmployees] = useState<Employee[]>([]);
    const [loadingEmployees, setLoadingEmployees] = useState(false);
    const [selectedEmployees, setSelectedEmployees] = useState<string[]>([]);
    const [showContractWarning, setShowContractWarning] = useState(false);
    /**
     * True once the administrator has touched a skip toggle in this session.
     *
     * The branch list can land after the modal is already open, and a roster the
     * administrator deliberately changed must not be silently reset by a
     * response arriving behind them.
     */
    const [skippedDaysEdited, setSkippedDaysEdited] = useState(false);
    const [formData, setFormData] = useState({
        startDate: '',
        endDate: '',
        shiftType: ShiftType.FULL_DAY,
        startTime: officeStart,
        endTime: officeEnd,
        requiredHours: defaultRequiredHours,
        notes: '',
        skippedDays: DEFAULT_SKIPPED_DAYS as number[],
    });
    const [errors, setErrors] = useState<Record<string, string>>({});
    /** The server's own refusal, shown in the form rather than in an alert(). */
    const [submitError, setSubmitError] = useState<string | null>(null);
    const [result, setResult] = useState<any>(null);

    useEffect(() => {
        if (isOpen) {
            fetchEmployees();
            resetForm();
        }
    }, [isOpen]);

    useEffect(() => {
        if (branding) {
            setFormData(prev => ({
                ...prev,
                startTime: branding.office_start_time || '08:30',
                endTime: branding.office_end_time || '17:30',
            }));
        }
    }, [branding]);

    // Adopt the branch's week whenever it becomes known — the list is fetched
    // when the modal opens, so it usually resolves a tick AFTER `resetForm` has
    // already seeded the toggles.
    useEffect(() => {
        if (!isOpen || skippedDaysEdited) return;
        setFormData(prev => ({ ...prev, skippedDays: branchSkippedDays }));
    }, [isOpen, branchSkippedDays, skippedDaysEdited]);

    const fetchEmployees = async () => {
        try {
            setLoadingEmployees(true);
            const response = await employeeService.getAll({ status: 'ACTIVE', limit: 500 });

            if (!response || !response.data) {
                console.error('Invalid response from API:', response);
                setEmployees([]);
                return;
            }

            setEmployees(response.data || []);
        } catch (error: any) {
            console.error('Error loading employee list:', error);
            console.error('Error details:', error.response?.data || error.message);
            setEmployees([]);
        } finally {
            setLoadingEmployees(false);
        }
    };

    const resetForm = () => {
        setFormData({
            startDate: '',
            endDate: '',
            shiftType: ShiftType.FULL_DAY,
            startTime: officeStart,
            endTime: officeEnd,
            requiredHours: defaultRequiredHours,
            notes: '',
            skippedDays: branchSkippedDays,
        });
        setSelectedEmployees([]);
        setSkippedDaysEdited(false);
        setErrors({});
        setResult(null);
    };

    const handleShiftTypeChange = (shiftType: ShiftType) => {
        let startTime = officeStart;
        let endTime = officeEnd;

        switch (shiftType) {
            case ShiftType.MORNING:
                startTime = '08:00';
                endTime = '12:00';
                break;
            case ShiftType.AFTERNOON:
                startTime = '13:00';
                endTime = officeEnd;
                break;
            case ShiftType.FULL_DAY:
                startTime = officeStart;
                endTime = officeEnd;
                break;
            case ShiftType.NIGHT:
                startTime = '18:00';
                endTime = '22:00';
                break;
        }

        setFormData(prev => ({
            ...prev,
            shiftType,
            startTime,
            endTime,
            requiredHours:
                shiftType === ShiftType.FLEXIBLE && !prev.requiredHours
                    ? defaultRequiredHours
                    : prev.requiredHours,
        }));
    };

    const toggleEmployee = (employeeId: string) => {
        setSelectedEmployees(prev =>
            prev.includes(employeeId)
                ? prev.filter(id => id !== employeeId)
                : [...prev, employeeId]
        );
    };

    const toggleAllEmployees = () => {
        if (selectedEmployees.length === employees.length) {
            setSelectedEmployees([]);
        } else {
            setSelectedEmployees(employees.map(emp => emp.id));
        }
    };

    const validate = () => {
        const newErrors: Record<string, string> = {};

        if (selectedEmployees.length === 0) {
            newErrors.employees = 'Please select at least 1 employee';
        }

        if (!formData.startDate) {
            newErrors.startDate = 'Please select a start date';
        }

        if (!formData.endDate) {
            newErrors.endDate = 'Please select an end date';
        }

        if (formData.startDate && formData.endDate && formData.startDate > formData.endDate) {
            newErrors.endDate = 'The end date must be after the start date';
        }

        const isFlexible = formData.shiftType === ShiftType.FLEXIBLE;

        if (isFlexible) {
            if (!formData.requiredHours || formData.requiredHours <= 0) {
                newErrors.requiredHours = 'Please enter the total working hours per day';
            } else if (formData.requiredHours > 24) {
                newErrors.requiredHours = 'Working hours cannot exceed 24';
            }
        } else {
            if (!formData.startTime) {
                newErrors.startTime = 'Please enter a start time';
            }

            if (!formData.endTime) {
                newErrors.endTime = 'Please enter an end time';
            }

            if (formData.startTime && formData.endTime && formData.startTime >= formData.endTime) {
                newErrors.endTime = 'The ending time must be after the starting time';
            }
        }

        setErrors(newErrors);
        return Object.keys(newErrors).length === 0;
    };

    const generateSchedules = (): BulkScheduleItem[] => {
        const schedules: BulkScheduleItem[] = [];
        const isFlexible = formData.shiftType === ShiftType.FLEXIBLE;

        // `datesBetween` reads the range as CALENDAR days. The previous loop
        // did `new Date(formData.startDate)` — which parses a bare date string
        // as UTC midnight — and then advanced it with `setDate(getDate() + 1)`,
        // which is local. At a negative UTC offset those two disagree by a day:
        // the range began on the day BEFORE the one the user picked, every
        // `getDay()` used for skip-days was the wrong weekday, and the first day
        // of the range was dropped entirely.
        //
        // The mirror image of the `toISOString()` bug on the schedule screens,
        // and invisible to the browser suite for the same reason: Playwright
        // pins `timezoneId: 'UTC'`, where both spellings agree.
        for (const date of datesBetween(formData.startDate, formData.endDate)) {
            // Skip selected days
            if (formData.skippedDays.includes(date.getDay())) {
                continue;
            }

            const dateStr = toCalendarDate(date);

            for (const employeeId of selectedEmployees) {
                const item: BulkScheduleItem = {
                    employeeId,
                    date: dateStr,
                    shiftType: formData.shiftType,
                    notes: formData.notes || undefined,
                };

                if (isFlexible) {
                    item.requiredHours = Number(formData.requiredHours);
                } else {
                    // Company TZ, not browser TZ (see ScheduleModal).
                    item.startTime = buildUTCFromLocal(dateStr, formData.startTime);
                    item.endTime = buildUTCFromLocal(dateStr, formData.endTime);
                }

                schedules.push(item);
            }
        }

        return schedules;
    };

    const executeSubmit = async () => {
        try {
            setLoading(true);
            setResult(null);
            setShowContractWarning(false);

            const schedules = generateSchedules();

            if (schedules.length === 0) {
                alert('No calendars have been created. Please check the date and settings again.');
                return;
            }

            if (schedules.length > 500) {
                if (!confirm(`You are about to create ${schedules.length} schedule. Continue?`)) {
                    return;
                }
            }

            const response = await calendarService.bulkCreateSchedules({ schedules });
            setResult(response.data);

            if (response.data.success === schedules.length) {
                setTimeout(() => {
                    onSuccess();
                    onClose();
                    resetForm();
                }, 2000);
            }
        } catch (error: any) {
            console.error('Error when creating batch calendar:', error);
            setSubmitError(
                apiErrorMessage(error, 'An error occurred while creating batch schedules'),
            );
        } finally {
            setLoading(false);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        if (!validate()) return;

        // Check if any selected employee lacks active contracts
        const noContractEmployees = selectedEmployees
            .map(id => employees.find(emp => emp.id === id))
            .filter((emp): emp is Employee => !!emp && !(emp.contracts && emp.contracts.length > 0));

        if (noContractEmployees.length > 0) {
            setShowContractWarning(true);
            return;
        }

        await executeSubmit();
    };

    const handleConfirmWarning = async () => {
        await executeSubmit();
    };

    if (!isOpen) return null;

    const totalSchedules = (() => {
        if (!formData.startDate || !formData.endDate) return 0;
        const start = new Date(formData.startDate);
        const end = new Date(formData.endDate);
        let count = 0;
        for (let date = new Date(start); date <= end; date.setDate(date.getDate() + 1)) {
            if (!formData.skippedDays.includes(date.getDay())) {
                count++;
            }
        }
        return count * selectedEmployees.length;
    })();

    // No <AnimatePresence> around this: `isOpen` returns null above, so the
    // modal unmounts before a presence could run its exit. Wrapping it also put
    // two unkeyed children under one presence, which framer keys as "" apiece —
    // React then warns about duplicate keys on every render.
    return (
        <>
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
                <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    className="bg-surface-card rounded-[--radius-card] shadow-xl max-w-4xl w-full max-h-[90vh] overflow-y-auto"
                >
                    {/* Header */}
                    <div className="flex items-center justify-between p-6 border-b border-surface-border">
                        <h2 className="text-2xl font-bold text-text-heading">Create bulk calendars</h2>
                        <button
                            onClick={onClose}
                            className="p-2 hover:bg-surface-border-light rounded-[--radius-button] transition-colors text-text-muted hover:text-text-heading"
                        >
                            <X size={20} />
                        </button>
                    </div>

                    {/* Form */}
                    <form data-testid="bulk-form" onSubmit={handleSubmit} className="p-6 space-y-6">
                        {submitError && (
                            <div
                                data-testid="bulk-form-error"
                                role="alert"
                                className="bg-status-error-bg/40 border border-status-error/30 text-status-error rounded-[--radius-input] px-4 py-3 text-sm font-medium"
                            >
                                {submitError}
                            </div>
                        )}
                        {/* Employee Selection */}
                        <div>
                            <div className="flex items-center justify-between mb-3">
                                <label className="block text-sm font-semibold text-text-heading">
                                    <Users size={16} className="inline mr-2 text-brand-primary" />
                                    Select employee <span className="text-status-error">*</span>
                                </label>
                                <button
                                    type="button"
                                    data-testid="bulk-select-all"
                                    onClick={toggleAllEmployees}
                                    className="text-sm text-brand-primary hover:underline cursor-pointer"
                                >
                                    {selectedEmployees.length === employees.length ? 'Deselect all' : 'Select all'}
                                </button>
                            </div>
                            <div className="border border-surface-border rounded-[--radius-input] max-h-60 overflow-y-auto">
                                {loadingEmployees ? (
                                    <div className="p-4 text-center text-text-muted">Loading...</div>
                                ) : employees.length === 0 ? (
                                    <div className="p-4 text-center text-text-muted">There are no staff</div>
                                ) : (
                                    <div className="divide-y divide-surface-border">
                                        {employees.map((emp) => (
                                            <label
                                                key={emp.id}
                                                className="flex items-center gap-3 p-3 hover:bg-surface-border-light cursor-pointer"
                                            >
                                                <input
                                                    data-testid={`bulk-employee-${emp.employeeCode}`}
                                                    type="checkbox"
                                                    checked={selectedEmployees.includes(emp.id)}
                                                    onChange={() => toggleEmployee(emp.id)}
                                                    className="w-4 h-4 text-brand-primary border-surface-border rounded-[--radius-input] focus:ring-brand-primary"
                                                />
                                                <span className="text-sm flex items-center gap-2 text-text-body">
                                                    {emp.employeeCode} - {emp.fullName}
                                                    {!(emp.contracts && emp.contracts.length > 0) && (
                                                        <span className="inline-flex items-center px-1.5 py-0.5 rounded-[--radius-badge] text-[10px] font-medium bg-status-warning-bg text-status-warning border border-status-warning/20">
                                                            No Contract
                                                        </span>
                                                    )}
                                                </span>
                                            </label>
                                        ))}
                                    </div>
                                )}
                            </div>
                            {errors.employees && (
                                <p className="text-status-error text-sm mt-1">{errors.employees}</p>
                            )}
                            <p className="text-sm text-text-muted mt-2">
                                Selected: {selectedEmployees.length} employees
                            </p>
                        </div>

                        {/* Date Range */}
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className="block text-sm font-semibold text-text-heading mb-2">
                                    <Calendar size={16} className="inline mr-2 text-brand-primary" />
                                    Start Date <span className="text-status-error">*</span>
                                </label>
                                <input
                                    data-testid="bulk-start"
                                    type="date"
                                    value={formData.startDate}
                                    onChange={(e) => setFormData({ ...formData, startDate: e.target.value })}
                                    className={`w-full px-4 py-3 border rounded-[--radius-input] focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary focus:outline-none ${errors.startDate ? 'border-status-error' : 'border-surface-border'
                                        }`}
                                    disabled={loading}
                                />
                                {errors.startDate && (
                                    <p className="text-status-error text-sm mt-1">{errors.startDate}</p>
                                )}
                            </div>

                            <div>
                                <label className="block text-sm font-semibold text-text-heading mb-2">
                                    <Calendar size={16} className="inline mr-2 text-brand-primary" />
                                    End Date <span className="text-status-error">*</span>
                                </label>
                                <input
                                    data-testid="bulk-end"
                                    type="date"
                                    value={formData.endDate}
                                    onChange={(e) => setFormData({ ...formData, endDate: e.target.value })}
                                    className={`w-full px-4 py-3 border rounded-[--radius-input] focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary focus:outline-none ${errors.endDate ? 'border-status-error' : 'border-surface-border'
                                        }`}
                                    disabled={loading}
                                />
                                {errors.endDate && (
                                    <p className="text-status-error text-sm mt-1">{errors.endDate}</p>
                                )}
                            </div>
                        </div>

                        {/* Skip Specific Days */}
                        <div className="space-y-2">
                            <label className="block text-sm font-semibold text-text-heading">
                                Skip Specific Days
                            </label>
                            <div className="flex flex-wrap gap-2">
                                {[
                                    { value: 0, label: 'Sun' },
                                    { value: 1, label: 'Mon' },
                                    { value: 2, label: 'Tue' },
                                    { value: 3, label: 'Wed' },
                                    { value: 4, label: 'Thu' },
                                    { value: 5, label: 'Fri' },
                                    { value: 6, label: 'Sat' },
                                ].map((day) => (
                                    <button
                                        key={day.value}
                                        type="button"
                                        data-testid={`bulk-skip-${day.value}`}
                                        data-skipped={formData.skippedDays.includes(day.value) ? 'true' : 'false'}
                                        onClick={() => {
                                            const newSkippedDays = formData.skippedDays.includes(day.value)
                                                ? formData.skippedDays.filter(d => d !== day.value)
                                                : [...formData.skippedDays, day.value];
                                            // Marks the branch default as overridden, so a late
                                            // branch response cannot undo this click.
                                            setSkippedDaysEdited(true);
                                            setFormData({ ...formData, skippedDays: newSkippedDays });
                                        }}
                                        className={`px-3 py-1.5 text-sm rounded-[--radius-button] border transition-all ${
                                            formData.skippedDays.includes(day.value)
                                                ? 'bg-brand-primary-light/20 border-brand-primary text-brand-primary font-semibold'
                                                : 'bg-surface-card border-surface-border text-text-body hover:bg-surface-border-light hover:border-surface-border'
                                        }`}
                                        disabled={loading}
                                    >
                                        {day.label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Shift Type */}
                        <div>
                            <label className="block text-sm font-semibold text-text-heading mb-2">
                                Shift <span className="text-status-error">*</span>
                            </label>
                            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                                {[
                                    { value: ShiftType.MORNING, label: 'Bright' },
                                    { value: ShiftType.AFTERNOON, label: 'Afternoon' },
                                    { value: ShiftType.FULL_DAY, label: 'All day' },
                                    { value: ShiftType.NIGHT, label: 'Dark' },
                                    { value: ShiftType.CUSTOM, label: 'Customize' },
                                    { value: ShiftType.FLEXIBLE, label: 'Flexible' },
                                ].map((shift) => (
                                    <button
                                        key={shift.value}
                                        type="button"
                                        data-testid={`bulk-type-${shift.value}`}
                                        data-selected={formData.shiftType === shift.value ? 'true' : 'false'}
                                        onClick={() => handleShiftTypeChange(shift.value)}
                                        className={`px-4 py-2 rounded-[--radius-button] border-2 transition-all ${formData.shiftType === shift.value
                                            ? 'border-brand-primary bg-brand-primary-light/20 text-brand-primary font-semibold'
                                            : 'border-surface-border hover:border-surface-border'
                                            }`}
                                        disabled={loading}
                                    >
                                        {shift.label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Flexible: total working hours target. Fixed: time range. */}
                        {formData.shiftType === ShiftType.FLEXIBLE ? (
                            <div>
                                <label className="block text-sm font-semibold text-text-heading mb-2">
                                    <Clock size={16} className="inline mr-2 text-brand-primary" />
                                    Total working hours / day <span className="text-status-error">*</span>
                                </label>
                                <input
                                    data-testid="bulk-hours"
                                    type="number"
                                    min={0.5}
                                    max={24}
                                    step={0.5}
                                    value={formData.requiredHours}
                                    onChange={(e) => setFormData({ ...formData, requiredHours: parseFloat(e.target.value) })}
                                    className={`w-full px-4 py-3 border rounded-[--radius-input] focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary focus:outline-none ${errors.requiredHours ? 'border-status-error' : 'border-surface-border'
                                        }`}
                                    disabled={loading}
                                />
                                <p className="text-text-muted text-xs mt-1">
                                    Applied to every generated day. Employees can check in/out any time across multiple sessions to reach this total.
                                </p>
                                {errors.requiredHours && (
                                    <p className="text-status-error text-sm mt-1">{errors.requiredHours}</p>
                                )}
                            </div>
                        ) : (
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-semibold text-text-heading mb-2">
                                        <Clock size={16} className="inline mr-2 text-brand-primary" />
                                        Start time <span className="text-status-error">*</span>
                                    </label>
                                    <input
                                        data-testid="bulk-time-start"
                                        type="time"
                                        value={formData.startTime}
                                        onChange={(e) => setFormData({ ...formData, startTime: e.target.value })}
                                        className={`w-full px-4 py-3 border rounded-[--radius-input] focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary focus:outline-none bg-surface-card text-text-body disabled:opacity-60 disabled:bg-surface-border-light/30 disabled:cursor-not-allowed ${errors.startTime ? 'border-status-error' : 'border-surface-border'
                                            }`}
                                        disabled={loading || formData.shiftType !== ShiftType.CUSTOM}
                                    />
                                    {errors.startTime && (
                                        <p className="text-status-error text-sm mt-1">{errors.startTime}</p>
                                    )}
                                </div>

                                <div>
                                    <label className="block text-sm font-semibold text-text-heading mb-2">
                                        <Clock size={16} className="inline mr-2 text-brand-primary" />
                                        End time <span className="text-status-error">*</span>
                                    </label>
                                    <input
                                        data-testid="bulk-time-end"
                                        type="time"
                                        value={formData.endTime}
                                        onChange={(e) => setFormData({ ...formData, endTime: e.target.value })}
                                        className={`w-full px-4 py-3 border rounded-[--radius-input] focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary focus:outline-none bg-surface-card text-text-body disabled:opacity-60 disabled:bg-surface-border-light/30 disabled:cursor-not-allowed ${errors.endTime ? 'border-status-error' : 'border-surface-border'
                                            }`}
                                        disabled={loading || formData.shiftType !== ShiftType.CUSTOM}
                                    />
                                    {errors.endTime && (
                                        <p className="text-status-error text-sm mt-1">{errors.endTime}</p>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* Notes */}
                        <div>
                            <label className="block text-sm font-semibold text-text-heading mb-2">
                                Note
                            </label>
                            <textarea
                                data-testid="bulk-notes"
                                value={formData.notes}
                                onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                                rows={2}
                                className="w-full px-4 py-3 border border-surface-border rounded-[--radius-input] focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary focus:outline-none resize-none bg-surface-card text-text-body placeholder-text-muted"
                                placeholder="Enter a common note for all calendars..."
                                disabled={loading}
                            />
                        </div>

                        {/* Summary */}
                        {totalSchedules > 0 && (
                            <div className="bg-status-info-bg/40 border border-status-info/20 rounded-lg p-4">
                                <div className="flex items-start gap-3">
                                    <AlertCircle className="text-status-info flex-shrink-0 mt-0.5" size={20} />
                                    <div>
                                        <p className="font-semibold text-status-info">Overview</p>
                                        <p className="text-sm text-status-info mt-1">
                                            Will create <span className="font-bold">{totalSchedules}</span> work schedule for{' '}
                                            <span className="font-bold">{selectedEmployees.length}</span> employees
                                        </p>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Result */}
                        {result && (
                            <div
                                data-testid="bulk-result"
                                className={`border rounded-lg p-4 ${result.failed === 0 ? 'bg-status-success-bg/40 border-status-success/20' : 'bg-status-warning-bg/40 border-status-warning/20'
                                }`}>
                                <div className="flex items-start gap-3">
                                    <CheckCircle className={`flex-shrink-0 mt-0.5 ${result.failed === 0 ? 'text-status-success' : 'text-status-warning'
                                        }`} size={20} />
                                    <div className="flex-1">
                                        <p className="font-semibold">Result</p>
                                        <p className="text-sm mt-1">
                                            Success: <span data-testid="bulk-result-success" className="font-bold text-status-success">{result.success}</span> |{' '}
                                            Failure: <span data-testid="bulk-result-failed" className="font-bold text-status-error">{result.failed}</span>
                                        </p>
                                        {result.errors && result.errors.length > 0 && (
                                            <div className="mt-3 max-h-40 overflow-y-auto">
                                                <p className="text-sm font-semibold mb-2">Error details:</p>
                                                <div className="space-y-1">
                                                    {result.errors.slice(0, 10).map((err: any, idx: number) => (
                                                        <p key={idx} data-testid={`bulk-error-row-${idx}`} className="text-xs text-status-error">
                                                            • {err.date} - {err.error}
                                                        </p>
                                                    ))}
                                                    {result.errors.length > 10 && (
                                                        <p className="text-xs text-text-muted">
                                                            ... and {result.errors.length - 10} other error
                                                        </p>
                                                    )}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Actions */}
                        <div className="flex items-center justify-end gap-3 pt-4 border-t border-surface-border">
                            <button
                                type="button"
                                data-testid="bulk-cancel"
                                onClick={onClose}
                                className="px-6 py-3 border border-surface-border rounded-[--radius-button] hover:bg-surface-border-light text-text-body transition-colors"
                                disabled={loading}
                            >
                                {result ? 'Close' : 'Cancel'}
                            </button>
                            {!result && (
                                <button
                                    data-testid="bulk-submit"
                                    type="submit"
                                    className="px-6 py-3 bg-brand-primary text-text-on-brand rounded-[--radius-button] hover:bg-brand-primary-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                                    disabled={loading || totalSchedules === 0}
                                >
                                    {loading && (
                                        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                                    )}
                                    Create {totalSchedules} calendar
                                </button>
                            )}
                        </div>
                    </form>
                </motion.div>
            </div>
            {/* Contract Warning Dialog */}
            <AnimatePresence>
                {showContractWarning && (
                    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
                        <motion.div
                            initial={{ opacity: 0, scale: 0.95 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.95 }}
                            data-testid="bulk-contract-warning"
                            className="bg-surface-card rounded-[--radius-card] shadow-2xl max-w-lg w-full p-6 border border-surface-border"
                        >
                            <div className="flex items-center gap-3 text-status-warning mb-4">
                                <div className="p-3 bg-status-warning-bg/40 rounded-[--radius-badge]">
                                    <AlertCircle size={28} />
                                </div>
                                <h3 className="text-xl font-bold text-text-heading">Missing Active Contracts</h3>
                            </div>
                            
                            <div className="text-text-body text-sm leading-relaxed mb-6">
                                <p className="mb-3">
                                    The following selected employee(s) do not have active labor contracts in the system:
                                </p>
                                <div className="max-h-40 overflow-y-auto bg-surface-page rounded-[--radius-input] p-3 border border-surface-border divide-y divide-surface-border-light mb-3">
                                    {selectedEmployees
                                        .map(id => employees.find(emp => emp.id === id))
                                        .filter((emp): emp is Employee => !!emp && !(emp.contracts && emp.contracts.length > 0))
                                        .map(emp => (
                                            <div key={emp.id} className="py-1 text-text-body font-medium text-xs">
                                                {emp.employeeCode} - {emp.fullName}
                                            </div>
                                        ))
                                    }
                                </div>
                                <p>
                                    Scheduling them may lead to payroll discrepancy or compliance issues. Are you sure you want to proceed anyway?
                                </p>
                            </div>

                            <div className="flex items-center justify-end gap-3">
                                <button
                                    type="button"
                                    data-testid="bulk-contract-cancel"
                                    onClick={() => setShowContractWarning(false)}
                                    className="px-4 py-2 text-sm font-semibold border border-surface-border rounded-[--radius-button] hover:bg-surface-border-light text-text-body transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    data-testid="bulk-contract-confirm"
                                    onClick={handleConfirmWarning}
                                    className="px-4 py-2 text-sm font-semibold bg-brand-accent hover:bg-brand-accent-dark text-text-on-accent rounded-[--radius-button] transition-colors shadow-sm"
                                >
                                    Confirm & Schedule
                                </button>
                            </div>
                        </motion.div>
                    </div>
                )}
            </AnimatePresence>
        </>
    );
}

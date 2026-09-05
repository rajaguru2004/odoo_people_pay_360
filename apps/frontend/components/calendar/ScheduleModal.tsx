'use client';

import { useState, useEffect } from 'react';
import { X, Clock, Calendar, User, FileText, AlertCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import calendarService from '@/services/calendarService';
import employeeService from '@/services/employeeService';
import authService from '@/services/authService';
import { ShiftType, CreateScheduleDto } from '@/types/calendar';
import { useBrandingStore } from '@/store/brandingStore';
import { usePermission } from '@/hooks/usePermission';
import { apiErrorMessage } from '@/utils/apiError';
import { toCalendarDate } from '@/utils/scheduleHours';
import { buildUTCFromLocal, toLocalTimeStr } from '@/utils/tzDate';

interface ScheduleModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSuccess: () => void;
    scheduleId?: string;
    initialDate?: Date;
    employeeId?: string; // For HR/Admin to create schedule for specific employee
}

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

export default function ScheduleModal({
    isOpen,
    onClose,
    onSuccess,
    scheduleId,
    initialDate,
    employeeId,
}: ScheduleModalProps) {
    const { branding } = useBrandingStore();
    const officeStart = branding?.office_start_time || '08:30';
    const officeEnd = branding?.office_end_time || '17:30';
    const defaultRequiredHours = Number(branding?.payroll_work_hours_per_day) || 8;

    const [loading, setLoading] = useState(false);
    const [employees, setEmployees] = useState<Employee[]>([]);
    const [loadingEmployees, setLoadingEmployees] = useState(false);
    const [showContractWarning, setShowContractWarning] = useState(false);
    const [formData, setFormData] = useState({
        employeeId: employeeId || '',
        date: initialDate ? toCalendarDate(initialDate) : '',
        shiftType: ShiftType.FULL_DAY,
        startTime: officeStart,
        endTime: officeEnd,
        requiredHours: defaultRequiredHours,
        isWorkDay: true,
        notes: '',
    });
    const [errors, setErrors] = useState<Record<string, string>>({});
    /** The server's own refusal, shown in the form rather than in an alert(). */
    const [submitError, setSubmitError] = useState<string | null>(null);
    const [currentUser, setCurrentUser] = useState<any>(null);
    const { can } = usePermission();
    /** May this user schedule somebody OTHER than themselves? */
    const canScheduleOthers = can('CREATE_SCHEDULE') || can('EDIT_SCHEDULE');

    useEffect(() => {
        if (!scheduleId && branding) {
            setFormData(prev => ({
                ...prev,
                startTime: branding.office_start_time || '08:30',
                endTime: branding.office_end_time || '17:30',
            }));
        }
    }, [branding, scheduleId]);

    useEffect(() => {
        const user = authService.getUser();
        setCurrentUser(user);

        if (canScheduleOthers) {
            fetchEmployees();
        } else if (user?.employeeId) {
            // Regular user can only see their own schedule
            setFormData(prev => ({ ...prev, employeeId: user.employeeId || '' }));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canScheduleOthers]);

    useEffect(() => {
        if (scheduleId) {
            fetchSchedule();
        } else {
            resetForm();
        }
    }, [scheduleId, initialDate, employeeId]);

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

    const fetchSchedule = async () => {
        if (!scheduleId) return;

        try {
            setLoading(true);
            const response = await calendarService.getSchedule(scheduleId);
            const schedule = response.data;

            const isFlexible = schedule.shiftType === ShiftType.FLEXIBLE;
            // Flexible shifts have no fixed times; keep office defaults in the
            // hidden time fields so a later switch to a fixed type has a value.
            // Read back in company TZ so the field shows the same wall clock the
            // calendar, the reminder email and the backend rules all use.
            const startTime = toLocalTimeStr(schedule.startTime);
            const endTime = toLocalTimeStr(schedule.endTime);

            setFormData({
                employeeId: schedule.employeeId,
                // The server sends `date` as a date-only column, so reading
                // its UTC calendar day is correct here — unlike `initialDate`,
                // which is local wall-clock.
                date: new Date(schedule.date).toISOString().split('T')[0],
                shiftType: schedule.shiftType,
                startTime: startTime || officeStart,
                endTime: endTime || officeEnd,
                requiredHours: isFlexible && schedule.requiredHours != null
                    ? Number(schedule.requiredHours)
                    : defaultRequiredHours,
                isWorkDay: schedule.isWorkDay,
                notes: schedule.notes || '',
            });
        } catch (err) {
            console.error('Error loading work schedule:', err);
            setSubmitError(
                apiErrorMessage(err, 'Unable to load this work schedule.'),
            );
            onClose();
        } finally {
            setLoading(false);
        }
    };

    const resetForm = () => {
        setFormData({
            employeeId: employeeId || currentUser?.employeeId || '',
            date: initialDate ? toCalendarDate(initialDate) : '',
            shiftType: ShiftType.FULL_DAY,
            startTime: officeStart,
            endTime: officeEnd,
            requiredHours: defaultRequiredHours,
            isWorkDay: true,
            notes: '',
        });
        setErrors({});
        setSubmitError(null);
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

    const validate = () => {
        const newErrors: Record<string, string> = {};

        if (!formData.employeeId) {
            newErrors.employeeId = 'Please select staff';
        }

        if (!formData.date) {
            newErrors.date = 'Please select a date';
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

        // Validate date boundaries against active contract if it exists
        if (formData.date && formData.employeeId) {
            const selectedEmployee = employees.find(emp => emp.id === formData.employeeId);
            const activeContract = selectedEmployee?.contracts?.[0];
            if (activeContract) {
                const checkDate = new Date(formData.date);
                const start = new Date(activeContract.startDate);
                const end = activeContract.endDate ? new Date(activeContract.endDate) : null;
                
                checkDate.setHours(0, 0, 0, 0);
                start.setHours(0, 0, 0, 0);
                if (end) end.setHours(0, 0, 0, 0);
                
                if (checkDate < start) {
                    newErrors.date = `Work date must be after the contract start date (${activeContract.startDate.split('T')[0]})`;
                } else if (activeContract.endDate && end && checkDate > end) {
                    newErrors.date = `Work date must be before the contract end date (${activeContract.endDate.split('T')[0]})`;
                }
            }
        }

        setErrors(newErrors);
        if (Object.keys(newErrors).length > 0) setSubmitError(null);
        return Object.keys(newErrors).length === 0;
    };

    const executeSubmit = async () => {
        try {
            setLoading(true);

            const isFlexible = formData.shiftType === ShiftType.FLEXIBLE;

            const payload: CreateScheduleDto = {
                employeeId: formData.employeeId,
                date: formData.date,
                shiftType: formData.shiftType,
                isWorkDay: formData.isWorkDay,
                notes: formData.notes || undefined,
            };

            if (isFlexible) {
                // No fixed window: send the daily hours target instead of times.
                payload.requiredHours = Number(formData.requiredHours);
            } else {
                // Company TZ, not browser TZ — the shift belongs to the office,
                // not to the admin's laptop clock.
                payload.startTime = buildUTCFromLocal(formData.date, formData.startTime);
                payload.endTime = buildUTCFromLocal(formData.date, formData.endTime);
            }

            if (scheduleId) {
                await calendarService.updateSchedule(scheduleId, payload);
            } else {
                await calendarService.createSchedule(payload);
            }

            onSuccess();
            onClose();
            resetForm();
            setShowContractWarning(false);
        } catch (err: any) {
            console.error('Error when saving work schedule:', err);
            setSubmitError(
                apiErrorMessage(err, 'An error occurred while saving the work schedule'),
            );
        } finally {
            setLoading(false);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        if (!validate()) return;

        // Check if employee has active contract (only check if HR/Admin)
        if (canScheduleOthers && formData.employeeId) {
            const selectedEmployee = employees.find(emp => emp.id === formData.employeeId);
            const hasActiveContract = selectedEmployee ? (selectedEmployee.contracts && selectedEmployee.contracts.length > 0) : true;
            
            if (!hasActiveContract) {
                setShowContractWarning(true);
                return;
            }
        }

        await executeSubmit();
    };

    const handleConfirmWarning = async () => {
        await executeSubmit();
    };

    if (!isOpen) return null;

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
                    className="bg-surface-card rounded-[--radius-card] shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto"
                >
                    {/* Header */}
                    <div className="flex items-center justify-between p-6 border-b border-surface-border">
                        <h2 className="text-2xl font-bold text-text-heading">
                            {scheduleId ? 'Edit work schedule' : 'Create a work schedule'}
                        </h2>
                        <button
                            data-testid="sched-form-close"
                            onClick={onClose}
                            className="p-2 hover:bg-surface-border-light rounded-[--radius-button] transition-colors text-text-muted hover:text-text-heading"
                        >
                            <X size={20} />
                        </button>
                    </div>

                    {/* Form */}
                    <form data-testid="sched-form" onSubmit={handleSubmit} className="p-6 space-y-6">
                        {submitError && (
                            <div
                                data-testid="sched-form-error"
                                role="alert"
                                className="bg-status-error-bg/40 border border-status-error/30 text-status-error rounded-[--radius-input] px-4 py-3 text-sm font-medium"
                            >
                                {submitError}
                            </div>
                        )}
                        {/* Employee Selection (HR/Admin only) */}
                        {canScheduleOthers && (
                            <div>
                                <label className="block text-sm font-semibold text-text-heading mb-2">
                                    <User size={16} className="inline mr-2 text-brand-primary" />
                                    Employee <span className="text-status-error">*</span>
                                </label>
                                <select
                                    data-testid="sched-form-employee"
                                    value={formData.employeeId}
                                    onChange={(e) => setFormData({ ...formData, employeeId: e.target.value })}
                                    className={`w-full px-4 py-3 border rounded-[--radius-input] focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary focus:outline-none bg-surface-card text-text-body ${errors.employeeId ? 'border-status-error' : 'border-surface-border'
                                        }`}
                                    disabled={loading || loadingEmployees || !!scheduleId}
                                >
                                    <option value="">-- Select employee --</option>
                                    {employees.map((emp) => (
                                        <option key={emp.id} value={emp.id}>
                                            {emp.employeeCode} - {emp.fullName}
                                        </option>
                                    ))}
                                </select>
                                {errors.employeeId && (
                                    <p data-testid="sched-form-error-employeeId" className="text-status-error text-sm mt-1">{errors.employeeId}</p>
                                )}
                                {formData.employeeId && (() => {
                                    const selectedEmployee = employees.find(emp => emp.id === formData.employeeId);
                                    const hasActiveContract = selectedEmployee ? (selectedEmployee.contracts && selectedEmployee.contracts.length > 0) : true;
                                    if (!hasActiveContract) {
                                        return (
                                            <div className="mt-2 p-3 bg-status-warning-bg text-status-warning border border-status-warning/20 rounded-[--radius-input] flex items-start gap-2.5 text-sm animate-fadeIn">
                                                <AlertCircle size={18} className="text-status-warning flex-shrink-0 mt-0.5" />
                                                <div>
                                                    <span className="font-semibold text-status-warning">No Active Contract:</span> This employee has no active contract. Shift scheduling will be allowed but requires confirmation.
                                                </div>
                                            </div>
                                        );
                                    }
                                    return null;
                                })()}
                            </div>
                        )}

                        {/* Date */}
                        <div>
                            <label className="block text-sm font-semibold text-text-heading mb-2">
                                <Calendar size={16} className="inline mr-2 text-brand-primary" />
                                Workday <span className="text-status-error">*</span>
                            </label>
                            <input
                                data-testid="sched-form-date"
                                type="date"
                                value={formData.date}
                                onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                                className={`w-full px-4 py-3 border rounded-[--radius-input] focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary focus:outline-none bg-surface-card text-text-body ${errors.date ? 'border-status-error' : 'border-surface-border'
                                    }`}
                                disabled={loading}
                            />
                            {errors.date && (
                                <p data-testid="sched-form-error-date" className="text-status-error text-sm mt-1">{errors.date}</p>
                            )}
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
                                        data-testid={`sched-form-type-${shift.value}`}
                                        type="button"
                                        onClick={() => handleShiftTypeChange(shift.value)}
                                         className={`px-4 py-2 rounded-[--radius-button] border-2 transition-all ${formData.shiftType === shift.value
                                             ? 'border-brand-primary bg-brand-primary-light/20 text-brand-primary font-semibold'
                                             : 'border-surface-border hover:border-surface-border text-text-body bg-surface-card'
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
                                    data-testid="sched-form-hours"
                                    type="number"
                                    min={0.5}
                                    max={24}
                                    step={0.5}
                                    value={formData.requiredHours}
                                    onChange={(e) => setFormData({ ...formData, requiredHours: parseFloat(e.target.value) })}
                                    className={`w-full px-4 py-3 border rounded-[--radius-input] focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary focus:outline-none bg-surface-card text-text-body ${errors.requiredHours ? 'border-status-error' : 'border-surface-border'
                                        }`}
                                    disabled={loading}
                                />
                                <p className="text-text-muted text-xs mt-1">
                                    The employee can check in/out any time and split the day across multiple sessions to reach this total.
                                </p>
                                {errors.requiredHours && (
                                    <p data-testid="sched-form-error-requiredHours" className="text-status-error text-sm mt-1">{errors.requiredHours}</p>
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
                                        data-testid="sched-form-start"
                                        type="time"
                                        value={formData.startTime}
                                        onChange={(e) => setFormData({ ...formData, startTime: e.target.value })}
                                        className={`w-full px-4 py-3 border rounded-[--radius-input] focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary focus:outline-none bg-surface-card text-text-body disabled:opacity-60 disabled:bg-surface-border-light/30 disabled:cursor-not-allowed ${errors.startTime ? 'border-status-error' : 'border-surface-border'
                                            }`}
                                        disabled={loading || formData.shiftType !== ShiftType.CUSTOM}
                                    />
                                    {errors.startTime && (
                                        <p data-testid="sched-form-error-startTime" className="text-status-error text-sm mt-1">{errors.startTime}</p>
                                    )}
                                </div>

                                <div>
                                    <label className="block text-sm font-semibold text-text-heading mb-2">
                                        <Clock size={16} className="inline mr-2 text-brand-primary" />
                                        End time <span className="text-status-error">*</span>
                                    </label>
                                    <input
                                        data-testid="sched-form-end"
                                        type="time"
                                        value={formData.endTime}
                                        onChange={(e) => setFormData({ ...formData, endTime: e.target.value })}
                                        className={`w-full px-4 py-3 border rounded-[--radius-input] focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary focus:outline-none bg-surface-card text-text-body disabled:opacity-60 disabled:bg-surface-border-light/30 disabled:cursor-not-allowed ${errors.endTime ? 'border-status-error' : 'border-surface-border'
                                            }`}
                                        disabled={loading || formData.shiftType !== ShiftType.CUSTOM}
                                    />
                                    {errors.endTime && (
                                        <p data-testid="sched-form-error-endTime" className="text-status-error text-sm mt-1">{errors.endTime}</p>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* Is Work Day */}
                        <div className="flex items-center gap-3">
                            <input
                                data-testid="sched-form-workday"
                                type="checkbox"
                                id="isWorkDay"
                                checked={formData.isWorkDay}
                                onChange={(e) => setFormData({ ...formData, isWorkDay: e.target.checked })}
                                className="w-5 h-5 text-brand-primary border-surface-border rounded-[--radius-input] focus:ring-brand-primary cursor-pointer"
                                disabled={loading}
                            />
                            <label htmlFor="isWorkDay" className="text-sm font-medium text-text-body cursor-pointer">
                                Official working day
                            </label>
                        </div>

                        {/* Notes */}
                        <div>
                            <label className="block text-sm font-semibold text-text-heading mb-2">
                                <FileText size={16} className="inline mr-2 text-brand-primary" />
                                Note
                            </label>
                            <textarea
                                data-testid="sched-form-notes"
                                value={formData.notes}
                                onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                                rows={3}
                                className="w-full px-4 py-3 border border-surface-border rounded-[--radius-input] focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary focus:outline-none resize-none bg-surface-card text-text-body placeholder-text-muted"
                                placeholder="Enter notes (if any)..."
                                disabled={loading}
                            />
                        </div>

                        {/* Actions */}
                        <div className="flex items-center justify-end gap-3 pt-4 border-t border-surface-border">
                            <button
                                type="button"
                                data-testid="sched-form-cancel"
                                onClick={onClose}
                                className="px-6 py-3 border border-surface-border rounded-[--radius-button] hover:bg-surface-border-light text-text-body transition-colors"
                                disabled={loading}
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                data-testid="sched-form-submit"
                                className="px-6 py-3 bg-brand-primary text-text-on-brand rounded-[--radius-button] hover:bg-brand-primary-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 cursor-pointer"
                                disabled={loading}
                            >
                                {loading && (
                                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                                )}
                                {scheduleId ? 'Update' : 'Create a calendar'}
                            </button>
                        </div>
                    </form>
                </motion.div>
            </div>
            {/* Contract Warning Dialog */}
            <AnimatePresence>
                {showContractWarning && (
                    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
                        <motion.div
                            data-testid="sched-contract-warning"
                            initial={{ opacity: 0, scale: 0.95 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.95 }}
                            className="bg-surface-card rounded-[--radius-card] shadow-2xl max-w-md w-full p-6 border border-surface-border"
                        >
                            <div className="flex items-center gap-3 text-status-warning mb-4">
                                <div className="p-3 bg-status-warning-bg/40 rounded-[--radius-badge]">
                                    <AlertCircle size={28} />
                                </div>
                                <h3 className="text-xl font-bold text-text-heading">Missing Active Contract</h3>
                            </div>
                            
                            <p className="text-text-body text-sm leading-relaxed mb-6">
                                Employee <span className="font-semibold text-text-heading">
                                    {employees.find(emp => emp.id === formData.employeeId)?.fullName}
                                </span> does not have an active labor contract in the system. 
                                <br /><br />
                                Scheduling them may lead to payroll discrepancy or compliance issues. Are you sure you want to proceed anyway?
                            </p>

                            <div className="flex items-center justify-end gap-3">
                                <button
                                    type="button"
                                    data-testid="sched-contract-cancel"
                                    onClick={() => setShowContractWarning(false)}
                                    className="px-4 py-2 text-sm font-semibold border border-surface-border rounded-[--radius-button] hover:bg-surface-border-light text-text-body transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    data-testid="sched-contract-confirm"
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

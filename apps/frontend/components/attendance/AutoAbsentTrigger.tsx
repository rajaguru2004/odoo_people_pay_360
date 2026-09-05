'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { UserX, Loader2, CheckCircle, AlertCircle, Users, Calendar, Clock } from 'lucide-react';
import attendanceService from '@/services/attendanceService';
import { apiErrorMessage } from '@/utils/apiError';
import { useBrandingStore } from '@/store/brandingStore';

interface AutoAbsentResult {
    date: Date;
    totalActive: number;
    markedAbsent: number;
    onLeave: number;
    checkedIn: number;
    absentEmployees: Array<{
        id: string;
        code: string;
        name: string;
        department: string;
    }>;
}

const formatTimeString = (timeStr: string): string => {
    if (!timeStr) return '';
    const [hour, min] = timeStr.split(':').map(Number);
    if (isNaN(hour) || isNaN(min)) return timeStr;
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const displayHour = hour % 12 || 12;
    const displayMin = min < 10 ? `0${min}` : min;
    return `${displayHour}:${displayMin} ${ampm}`;
};

export default function AutoAbsentTrigger() {
    const t = useTranslations('autoAbsentTrigger');
    const tc = useTranslations('common');
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState<AutoAbsentResult | null>(null);
    const [showConfirm, setShowConfirm] = useState(false);

    const { branding } = useBrandingStore();
    const officeStartTime = branding?.office_start_time || '08:30';
    const officeEndTime = branding?.office_end_time || '17:30';

    const handleTrigger = async () => {
        setLoading(true);
        try {
            const response = await attendanceService.autoMarkAbsent();
            setResult(response.data);
            setShowConfirm(false);
        } catch (error: any) {
            // `lib/axios.ts` rejects with a FLAT object — there is no
            // `.response` on it, so `error.response?.data?.message` always read
            // undefined and the fallback always won. The server's actual
            // reason (e.g. "Skipped (Day-end boundary … not been reached yet)")
            // never reached the user.
            alert(apiErrorMessage(error, t('failedToMark')));
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="relative overflow-hidden">
            {/* Background Gradient */}
            <div className="absolute inset-0 bg-gradient-to-br from-status-warning-bg/20 to-status-error-bg/20 rounded-[--radius-card]" />

            {/* Content */}
            <div className="relative bg-surface-card rounded-[--radius-card] shadow-lg border border-surface-border p-6">
                {/* Header */}
                <div className="flex items-center gap-3 mb-6">
                    <div className="relative">
                        <div className="absolute inset-0 bg-brand-accent rounded-[--radius-input] blur-md opacity-30" />
                        <div className="relative w-12 h-12 bg-brand-accent rounded-[--radius-input] flex items-center justify-center shadow-lg">
                            <UserX className="w-6 h-6 text-text-on-accent" />
                        </div>
                    </div>
                    <div>
                        <h3 className="text-lg font-bold text-text-heading">{t('title')}</h3>
                        <p className="text-sm text-text-muted">{t('subtitle')}</p>
                    </div>
                </div>

                {/* Info Box */}
                <div className="relative overflow-hidden mb-6">
                    <div className="absolute inset-0 bg-gradient-to-r from-status-info-bg/30 to-brand-primary-light/30 rounded-[--radius-input]" />
                    <div className="relative bg-surface-card/60 backdrop-blur-sm border border-status-info/20 rounded-[--radius-input] p-4">
                        <div className="flex items-start gap-3">
                            <div className="flex-shrink-0">
                                <div className="w-8 h-8 bg-status-info rounded-[--radius-button] flex items-center justify-center">
                                    <AlertCircle className="w-4 h-4 text-text-on-brand" />
                                </div>
                            </div>
                            <div className="text-sm text-status-info">
                                <p className="font-bold mb-2 flex items-center gap-2">
                                    <Clock className="w-4 h-4" /> {t('importantNote')}
                                </p>
                                <ul className="space-y-1.5 text-status-info">
                                    <li className="flex items-start gap-2">
                                        <span className="text-status-info font-bold">•</span>
                                        <span>{t('workingHours')} <strong>{formatTimeString(officeStartTime)} - {formatTimeString(officeEndTime)}</strong></span>
                                    </li>
                                    <li className="flex items-start gap-2">
                                        <span className="text-status-info font-bold">•</span>
                                        <span>{t('autoMarkDesc', { hours: formatTimeString(officeEndTime) })}</span>
                                    </li>
                                    <li className="flex items-start gap-2">
                                        <span className="text-status-info font-bold">•</span>
                                        <span>{t('onlyEmployeesPart1')} <strong>{t('noCheckInRecord')}</strong> {t('andWord')} <strong>{t('noApprovedLeave')}</strong> {t('willBeMarked')}</span>
                                    </li>
                                    <li className="flex items-start gap-2">
                                        <span className="text-status-info font-bold">•</span>
                                        <span>{t('useManualButtonPart1')} <strong>{t('onlyWhenRequired')}</strong>.</span>
                                    </li>
                                </ul>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Trigger Button */}
                {!showConfirm ? (
                    <button
                        data-testid="absent-open"
                        onClick={() => setShowConfirm(true)}
                        className="w-full px-6 py-3 bg-brand-accent hover:bg-brand-accent-dark text-text-on-accent rounded-[--radius-button] flex items-center justify-center gap-2 font-semibold shadow-lg hover:shadow-xl transition-all"
                    >
                        <UserX className="w-5 h-5" /> {t('runManually')}
                    </button>
                ) : (
                    <div className="space-y-3">
                        <div className="relative overflow-hidden">
                            <div className="absolute inset-0 bg-status-warning-bg/40 rounded-[--radius-input]" />
                            <div className="relative bg-surface-card/60 backdrop-blur-sm border border-status-warning/20 rounded-[--radius-input] p-4">
                                <div className="flex items-start gap-3">
                                    <AlertCircle className="w-5 h-5 text-status-warning flex-shrink-0 mt-0.5" />
                                    <p className="text-sm text-status-warning font-semibold">
                                        {t('confirmMarkAbsent')}
                                    </p>
                                </div>
                            </div>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <button
                                data-testid="absent-confirm"
                                onClick={handleTrigger}
                                disabled={loading}
                                className="px-6 py-3 bg-brand-accent hover:bg-brand-accent-dark text-text-on-accent rounded-[--radius-button] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 font-semibold shadow-lg hover:shadow-xl transition-all"
                            >
                                {loading ? (
                                    <>
                                        <Loader2 className="w-5 h-5 animate-spin" /> {tc('processing')}
                                    </>
                                ) : (
                                    <>
                                        <CheckCircle className="w-5 h-5" /> {tc('confirm')}
                                    </>
                                )}
                            </button>
                            <button
                                data-testid="absent-cancel"
                                onClick={() => setShowConfirm(false)}
                                disabled={loading}
                                className="px-6 py-3 bg-surface-page hover:bg-surface-border-light text-text-body rounded-[--radius-button] disabled:opacity-50 font-semibold transition-all border border-surface-border"
                            >
                                {tc('cancel')}
                            </button>
                        </div>
                    </div>
                )}

                {/* Results */}
                {result && (
                    <div className="mt-6 space-y-4">
                        <div className="h-px bg-gradient-to-r from-transparent via-surface-border to-transparent" />
                        <h4 className="font-bold text-text-heading flex items-center gap-2">
                            <CheckCircle className="w-5 h-5 text-status-success" /> {t('executionResults')}
                        </h4>

                        {/* Stats Grid */}
                        <div className="grid grid-cols-2 gap-3">
                            <div className="relative overflow-hidden bg-surface-page rounded-[--radius-input] p-3 border border-surface-border">
                                <div className="flex items-center gap-2 mb-1">
                                    <Users className="w-4 h-4 text-text-muted" />
                                    <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">{t('totalEmployees')}</span>
                                </div>
                                <div className="text-xl font-bold text-text-heading">{result.totalActive}</div>
                            </div>
                            <div className="relative overflow-hidden bg-status-error-bg/30 rounded-[--radius-input] p-3 border border-status-error/20">
                                <div className="flex items-center gap-2 mb-1">
                                    <UserX className="w-4 h-4 text-status-error" />
                                    <span className="text-xs font-semibold text-status-error uppercase tracking-wide">{tc('absent')}</span>
                                </div>
                                <div
                                    data-testid="absent-result"
                                    data-marked={result.markedAbsent}
                                    className="text-xl font-bold text-status-error"
                                >
                                    {result.markedAbsent}
                                </div>
                            </div>
                            <div className="relative overflow-hidden bg-status-info-bg/30 rounded-[--radius-input] p-3 border border-status-info/20">
                                <div className="flex items-center gap-2 mb-1">
                                    <Calendar className="w-4 h-4 text-status-info" />
                                    <span className="text-xs font-semibold text-status-info uppercase tracking-wide">{t('permitted')}</span>
                                </div>
                                <div className="text-xl font-bold text-status-info">{result.onLeave}</div>
                            </div>
                            <div className="relative overflow-hidden bg-status-success-bg/30 rounded-[--radius-input] p-3 border border-status-success/20">
                                <div className="flex items-center gap-2 mb-1">
                                    <CheckCircle className="w-4 h-4 text-status-success" />
                                    <span className="text-xs font-semibold text-status-success uppercase tracking-wide">{t('checkedIn')}</span>
                                </div>
                                <div className="text-xl font-bold text-status-success">{result.checkedIn}</div>
                            </div>
                        </div>

                        {/* Absent Employees List */}
                        {result.absentEmployees.length > 0 ? (
                            <div>
                                <h5 className="text-sm font-bold text-text-heading mb-3 flex items-center gap-2">
                                    <UserX className="w-4 h-4 text-status-error" /> {t('employeesAbsentCount', { count: result.absentEmployees.length })}
                                </h5>
                                <div className="space-y-2 max-h-60 overflow-y-auto pr-2 custom-scrollbar">
                                    {result.absentEmployees.map((emp) => (
                                        <div
                                            key={emp.id}
                                            className="flex items-center justify-between p-3 bg-surface-card border border-surface-border rounded-[--radius-input] hover:shadow-md transition-shadow"
                                        >
                                            <div>
                                                <div className="font-bold text-text-heading">{emp.name}</div>
                                                <div className="text-sm text-text-muted font-medium">
                                                    {emp.code} • {emp.department || t('noDepartments')}
                                                </div>
                                            </div>
                                            <div className="px-3 py-1.5 bg-status-error text-text-on-brand text-xs font-bold rounded-[--radius-badge] shadow-md"> {t('absentBadge')} </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ) : (
                            <div className="relative overflow-hidden">
                                <div className="absolute inset-0 bg-status-success-bg/40 rounded-[--radius-input]" />
                                <div className="relative bg-surface-card/60 backdrop-blur-sm border border-status-success/20 rounded-[--radius-input] p-4 text-center">
                                    <div className="w-12 h-12 bg-status-success rounded-full flex items-center justify-center mx-auto mb-3 shadow-lg">
                                        <CheckCircle className="w-6 h-6 text-text-on-brand" />
                                    </div>
                                    <p className="text-status-success font-bold mb-1"> {t('noEmployeesAbsent')} </p>
                                    <p className="text-sm text-status-success">
                                        {t('allCheckedIn')}
                                    </p>
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

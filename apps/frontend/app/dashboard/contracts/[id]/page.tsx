'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
    FileText, User, Calendar, Clock,
    Briefcase, Building2, Mail, Phone, Hash, AlertCircle,
    CheckCircle2, XCircle, FileCheck, Edit, History
} from 'lucide-react';
import { CurrencyIcon } from '@/components/common/CurrencyIcon';
import PageActionRow from '@/components/common/PageActionRow';
import { usePageHeader } from '@/hooks/usePageHeader';
import contractService from '@/services/contractService';
import terminationRequestService from '@/services/terminationRequestService';
import { Contract } from '@/types/contract';
import { toast } from '@/lib/toast';
import TerminationRequestForm from '@/components/contracts/TerminationRequestForm';
import { formatCurrency, getCompanyTz } from '@/utils/formatters';
import TerminationHistory from '@/components/contracts/TerminationHistory';
import { useAuthStore } from '@/store/authStore';
import ProtectedRoute from '@/components/auth/ProtectedRoute';

export default function ContractDetailPage() {
    const t = useTranslations('contractDetailPage');
    const tc = useTranslations('common');
    const router = useRouter();
    const params = useParams();
    const id = params.id as string;
    const { user } = useAuthStore();

    // The one heading for this route, rendered by TopHeader. Declared above the
    // loading/not-found early-returns so the hook order never changes. The
    // contract number and status live in the metadata row below, not a subtitle.
    usePageHeader(t('title'));

    const [contract, setContract] = useState<Contract | null>(null);
    const [loading, setLoading] = useState(true);
    const [showTerminateModal, setShowTerminateModal] = useState(false);
    const [pendingTermination, setPendingTermination] = useState<any>(null);
    const [loadingTermination, setLoadingTermination] = useState(false);

    useEffect(() => {
        if (id) {
            fetchContract();
            checkPendingTermination();
        }
    }, [id]);

    const fetchContract = async () => {
        try {
            setLoading(true);
            const response = await contractService.getById(id);
            if (response.success && response.data) {
                setContract(response.data);
            }
        } catch (error) {
            console.error('Failed to fetch contract:', error);
            toast.error(t('loadFailed'));
        } finally {
            setLoading(false);
        }
    };

    const checkPendingTermination = async () => {
        try {
            setLoadingTermination(true);
            const response = await terminationRequestService.getByContract(id);
            if (response.success && response.data) {
                // Find pending request
                const pending = response.data.find((req: any) => req.status === 'PENDING_APPROVAL');
                setPendingTermination(pending || null);
            }
        } catch (error) {
            console.error('Failed to check termination:', error);
        } finally {
            setLoadingTermination(false);
        }
    };

    const formatDate = (date: string) => {
        return new Date(date).toLocaleDateString('en-IN', { timeZone: getCompanyTz(), 
            day: 'numeric',
            month: 'long',
            year: 'numeric',
        });
    };

    const getStatusBadge = (status: string) => {
        const config: Record<string, { bg: string; text: string; label: string }> = {
            ACTIVE: { bg: 'bg-status-success-bg', text: 'text-status-success', label: t('statusActive') },
            EXPIRED: { bg: 'bg-status-error-bg', text: 'text-status-error', label: t('statusExpired') },
            TERMINATED: { bg: 'bg-surface-page', text: 'text-text-muted', label: t('statusTerminated') },
        };
        const { bg, text, label } = config[status] || config.ACTIVE;
        return (
            <span className={`px-3 py-1 rounded-[--radius-badge] text-sm font-semibold border border-surface-border/50 ${bg} ${text}`}> {label} </span>
        );
    };

    const getContractTypeLabel = (type: string) => {
        const labels: Record<string, string> = {
            PROBATION: t('typeProbation'),
            FIXED_TERM: t('typeFixedTerm'),
            INDEFINITE: t('typeIndefinite'),
        };
        return labels[type] || type;
    };

    const getWorkTypeLabel = (type: string) => {
        const labels: Record<string, string> = {
            FULL_TIME: t('workFullTime'),
            PART_TIME: t('workPartTime'),
        };
        return labels[type] || type;
    };

    const calculateContractDuration = () => {
        if (!contract) return null;
        const start = new Date(contract.startDate);
        const end = contract.endDate ? new Date(contract.endDate) : new Date();
        const diffTime = Math.abs(end.getTime() - start.getTime());
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        const months = Math.floor(diffDays / 30);
        const days = diffDays % 30;
        return { months, days, totalDays: diffDays };
    };

    const calculateDaysRemaining = () => {
        if (!contract?.endDate) return null;
        const today = new Date();
        const end = new Date(contract.endDate);
        const diffTime = end.getTime() - today.getTime();
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        return diffDays;
    };

    if (loading) {
        return (
            <>
                <div className="flex items-center justify-center h-64">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-brand-primary"></div>
                </div>
            </>
        );
    }

    if (!contract) {
        return (
            <>
                <div className="text-center py-12">
                    <FileText className="w-16 h-16 text-text-muted mx-auto mb-4" />
                    <p className="text-text-muted font-medium mb-4">{t('noContractFound')}</p>
                    <button onClick={() => router.push('/dashboard/contracts')} className="text-brand-primary hover:text-brand-primary-dark font-semibold cursor-pointer">
                        {t('returnToListArrow')}
                    </button>
                </div>
            </>
        );
    }

    return (
        <ProtectedRoute requiredPermission="VIEW_CONTRACTS">
            <div className="max-w-7xl mx-auto space-y-6">
                {/* Heading lives in TopHeader via usePageHeader — the back navigation,
                    the termination action and the contract metadata row stay here. */}
                <div className="space-y-3">
                    <PageActionRow
                        onBack={() => router.push('/dashboard/contracts')}
                        action={
                            contract.status === 'ACTIVE' && (
                                pendingTermination ? (
                                    <div className="flex items-center gap-2 px-4 py-2 bg-status-warning-bg/40 border border-status-warning/20 rounded-[--radius-button]">
                                        <Clock size={16} className="text-status-warning" />
                                        <span className="text-sm font-semibold text-status-warning">
                                            {t('waitingApprovalToEnd')}
                                        </span>
                                    </div>
                                ) : (
                                    <button
                                        onClick={() => setShowTerminateModal(true)}
                                        disabled={loadingTermination}
                                        className="px-4 py-2 bg-status-error text-text-on-brand rounded-[--radius-button] hover:bg-status-error/90 font-semibold transition-all text-sm disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                                        title={t('createTerminationTitle')}
                                    >
                                        {t('terminationRequestBtn')}
                                    </button>
                                )
                            )
                        }
                    />
                    <div className="flex items-center gap-3">
                        <p className="text-text-body">
                            {t('contractNumberPrefix')}<span className="font-bold text-text-heading">{contract.contractNumber}</span>
                        </p>
                        <span className="text-text-muted">•</span>
                        {getStatusBadge(contract.status)}
                    </div>
                </div>

                {/* Alert if contract expiring soon */}
                {contract.status === 'ACTIVE' && calculateDaysRemaining() !== null && calculateDaysRemaining()! <= 30 && calculateDaysRemaining()! > 0 && (
                    <div className="bg-status-warning-bg/40 border border-status-warning/20 rounded-[--radius-card] p-4 flex items-start gap-3">
                        <AlertCircle className="text-status-warning flex-shrink-0 mt-0.5" size={20} />
                        <div>
                            <p className="font-semibold text-status-warning">{t('expiringAlertTitle')}</p>
                            <p className="text-sm text-status-warning/90 mt-1">
                                {t('expiringAlertDesc', { days: calculateDaysRemaining() ?? 0 })}
                            </p>
                        </div>
                    </div>
                )}

                {/* Alert if pending termination */}
                {pendingTermination && (
                    <div className="bg-status-info-bg/40 border border-status-info/20 rounded-[--radius-card] p-4 flex items-start gap-3">
                        <Clock className="text-status-info flex-shrink-0 mt-0.5" size={20} />
                        <div className="flex-1">
                            <div className="flex items-center justify-between">
                                <p className="font-semibold text-status-info">{t('pendingTerminationTitle')}</p>
                                <button onClick={() => router.push('/dashboard/contracts/terminations')} className="text-sm text-brand-primary hover:text-brand-primary-dark font-semibold cursor-pointer">
                                    {t('seeDetailsArrow')}
                                </button>
                            </div>
                            <div className="mt-2 grid grid-cols-3 gap-3 text-sm">
                                <div>
                                    <span className="text-text-muted">{t('typeLabel')}</span>
                                    <span className="ms-1 font-semibold text-text-body">
                                        {pendingTermination.terminationCategory === 'RESIGNATION' ? t('categoryQuitWork') : pendingTermination.terminationCategory === 'TERMINATION' ? t('categoryDismissal') : pendingTermination.terminationCategory === 'CONTRACT_END' ? t('categoryContractExpires') : pendingTermination.terminationCategory === 'RETIREMENT' ? t('categoryRetirement') : t('categoryOther')}
                                    </span>
                                </div>
                                <div>
                                    <span className="text-text-muted">{t('terminationDateLabel')}</span>
                                    <span className="ms-1 font-semibold text-text-body">
                                        {new Date(pendingTermination.terminationDate).toLocaleDateString('en-IN', { timeZone: getCompanyTz() })}
                                    </span>
                                </div>
                                <div>
                                    <span className="text-text-muted">{t('requesterLabel')}</span>
                                    <span className="ms-1 font-semibold text-text-body">
                                        {pendingTermination.requester?.email || 'N/A'}
                                    </span>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* Main Content */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    {/* Left Column - Main Info */}
                    <div className="lg:col-span-2 space-y-6">
                        {/* Contract Overview Card */}
                        <div className="bg-gradient-to-br from-brand-primary to-brand-primary-dark rounded-[--radius-card] p-6 text-text-on-brand shadow-lg">
                            <div className="flex items-start justify-between mb-6">
                                <div>
                                    <p className="text-text-on-brand/80 text-sm mb-1">{t('contractType')}</p>
                                    <h2 className="text-2xl font-bold">{getContractTypeLabel(contract.contractType)}</h2>
                                </div>
                                <FileText size={40} className="text-text-on-brand/60 opacity-50" />
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                <div className="bg-white/10 rounded-[--radius-button] p-3 backdrop-blur-sm">
                                    <p className="text-text-on-brand/80 text-xs mb-1">{t('salary')}</p>
                                    <p className="text-xl font-bold">{formatCurrency(contract.salary)}</p>
                                </div>
                                <div className="bg-white/10 rounded-[--radius-button] p-3 backdrop-blur-sm">
                                    <p className="text-text-on-brand/80 text-xs mb-1">{t('workingForm')}</p>
                                    <p className="text-lg font-semibold">{getWorkTypeLabel(contract.workType || 'FULL_TIME')}</p>
                                    {contract.workType === 'PART_TIME' && (
                                        <p className="text-sm text-text-on-brand/80 mt-1">{t('hoursPerWeek', { hours: contract.workHoursPerWeek || 40 })}</p>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Contract Details */}
                        <div className="bg-surface-card rounded-[--radius-card] border border-surface-border p-6">
                            <div className="flex items-center gap-2 mb-5">
                                <FileCheck size={20} className="text-brand-primary" />
                                <h2 className="text-lg font-bold text-text-heading">{t('contractInfoHeading')}</h2>
                            </div>
                            <div className="grid grid-cols-2 gap-6">
                                <div className="flex items-start gap-3">
                                    <div className="w-10 h-10 rounded-[--radius-button] bg-status-success-bg flex items-center justify-center flex-shrink-0">
                                        <Calendar size={18} className="text-status-success" />
                                    </div>
                                    <div>
                                        <label className="text-xs text-text-muted font-medium">{t('startDate')}</label>
                                        <p className="text-text-body font-bold mt-1">{formatDate(contract.startDate)}</p>
                                    </div>
                                </div>
                                <div className="flex items-start gap-3">
                                    <div className="w-10 h-10 rounded-[--radius-button] bg-status-error-bg flex items-center justify-center flex-shrink-0">
                                        <Calendar size={18} className="text-status-error" />
                                    </div>
                                    <div>
                                        <label className="text-xs text-text-muted font-medium">{t('endDate')}</label>
                                        <p className="text-text-body font-bold mt-1">
                                            {contract.endDate ? formatDate(contract.endDate) : <span className="text-text-muted">{t('notDetermined')}</span>}
                                        </p>
                                    </div>
                                </div>
                                {calculateContractDuration() && (
                                    <div className="flex items-start gap-3 col-span-2">
                                        <div className="w-10 h-10 rounded-[--radius-button] bg-brand-primary-light/20 flex items-center justify-center flex-shrink-0">
                                            <Clock size={18} className="text-brand-primary" />
                                        </div>
                                        <div>
                                            <label className="text-xs text-text-muted font-medium">{t('contractTerm')}</label>
                                            <p className="text-text-body font-bold mt-1">
                                                {calculateContractDuration()!.months > 0 && t('monthsSuffix', { count: calculateContractDuration()!.months })}
                                                {calculateContractDuration()!.days > 0 && t('daysSuffix', { count: calculateContractDuration()!.days })}
                                                <span className="text-text-muted font-normal text-sm ms-2">{t('totalDaysSuffix', { count: calculateContractDuration()!.totalDays })}</span>
                                            </p>
                                        </div>
                                    </div>
                                )}
                                {contract.endDate && contract.status === 'ACTIVE' && calculateDaysRemaining() !== null && (
                                    <div className="flex items-start gap-3 col-span-2">
                                        <div className={`w-10 h-10 rounded-[--radius-button] flex items-center justify-center flex-shrink-0 ${
                                            calculateDaysRemaining()! <= 7 ? 'bg-status-error-bg' : calculateDaysRemaining()! <= 30 ? 'bg-status-warning-bg' : 'bg-status-info-bg'
                                        }`}>
                                            <AlertCircle size={18} className={
                                                calculateDaysRemaining()! <= 7 ? 'text-status-error' : calculateDaysRemaining()! <= 30 ? 'text-status-warning' : 'text-status-info'
                                            } />
                                        </div>
                                        <div>
                                            <label className="text-xs text-text-muted font-medium">{t('remainingTime')}</label>
                                            <p className={`font-bold mt-1 ${
                                                calculateDaysRemaining()! <= 7 ? 'text-status-error' : calculateDaysRemaining()! <= 30 ? 'text-status-warning' : 'text-text-heading'
                                            }`}>
                                                {calculateDaysRemaining()! > 0 ? t('daysRemaining', { count: calculateDaysRemaining() ?? 0 }) : tc('expired')}
                                            </p>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Employee Info */}
                        <div className="bg-surface-card rounded-[--radius-card] border border-surface-border p-6">
                            <div className="flex items-center justify-between mb-5">
                                <div className="flex items-center gap-2">
                                    <User size={20} className="text-brand-accent" />
                                    <h2 className="text-lg font-bold text-text-heading">{t('employeeInfoHeading')}</h2>
                                </div>
                                <button onClick={() => router.push(`/dashboard/employees/${contract.employeeId}`)} className="text-brand-primary hover:text-brand-primary-dark text-sm font-semibold cursor-pointer">
                                    {t('viewProfileArrow')}
                                </button>
                            </div>
                            <div className="grid grid-cols-2 gap-6">
                                <div className="flex items-start gap-3">
                                    <div className="w-10 h-10 rounded-[--radius-button] bg-surface-page flex items-center justify-center flex-shrink-0">
                                        <Hash size={18} className="text-text-muted" />
                                    </div>
                                    <div>
                                        <label className="text-xs text-text-muted font-medium">{t('employeeId')}</label>
                                        <p className="text-text-body font-bold mt-1">{contract.employee?.employeeCode || 'N/A'}</p>
                                    </div>
                                </div>
                                <div className="flex items-start gap-3">
                                    <div className="w-10 h-10 rounded-[--radius-button] bg-status-info-bg flex items-center justify-center flex-shrink-0">
                                        <User size={18} className="text-status-info" />
                                    </div>
                                    <div>
                                        <label className="text-xs text-text-muted font-medium">{t('fullName')}</label>
                                        <p className="text-text-body font-bold mt-1">{contract.employee?.fullName || 'N/A'}</p>
                                    </div>
                                </div>
                                <div className="flex items-start gap-3">
                                    <div className="w-10 h-10 rounded-[--radius-button] bg-status-success-bg flex items-center justify-center flex-shrink-0">
                                        <Briefcase size={18} className="text-status-success" />
                                    </div>
                                    <div>
                                        <label className="text-xs text-text-muted font-medium">{t('position')}</label>
                                        <p className="text-text-body font-bold mt-1">{contract.employee?.position || t('notUpdatedYet')}</p>
                                    </div>
                                </div>
                                <div className="flex items-start gap-3">
                                    <div className="w-10 h-10 rounded-[--radius-button] bg-brand-primary-light/20 flex items-center justify-center flex-shrink-0">
                                        <Building2 size={18} className="text-brand-primary" />
                                    </div>
                                    <div>
                                        <label className="text-xs text-text-muted font-medium">{t('department')}</label>
                                        <p className="text-text-body font-bold mt-1">{contract.employee?.department?.name || t('notUpdatedYet')}</p>
                                    </div>
                                </div>
                                {contract.employee?.email && (
                                    <div className="flex items-start gap-3">
                                        <div className="w-10 h-10 rounded-[--radius-button] bg-status-warning-bg flex items-center justify-center flex-shrink-0">
                                            <Mail size={18} className="text-status-warning" />
                                        </div>
                                        <div>
                                            <label className="text-xs text-text-muted font-medium">{t('email')}</label>
                                            <p className="text-text-body font-semibold mt-1 text-sm">{contract.employee.email}</p>
                                        </div>
                                    </div>
                                )}
                                {contract.employee?.phone && (
                                    <div className="flex items-start gap-3">
                                        <div className="w-10 h-10 rounded-[--radius-button] bg-status-info-bg flex items-center justify-center flex-shrink-0">
                                            <Phone size={18} className="text-status-info" />
                                        </div>
                                        <div>
                                            <label className="text-xs text-text-muted font-medium">{t('phoneNumber')}</label>
                                            <p className="text-text-body font-semibold mt-1">{contract.employee.phone}</p>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Notes */}
                        {contract.notes && (
                            <div className="bg-surface-card rounded-[--radius-card] border border-surface-border p-6">
                                <h2 className="text-lg font-bold text-text-heading mb-3">{t('notesHeading')}</h2>
                                <div className="bg-surface-page rounded-[--radius-button] p-4 border border-surface-border">
                                    <p className="text-text-body whitespace-pre-wrap">{contract.notes}</p>
                                </div>
                            </div>
                        )}

                        {/* Termination History */}
                        <div className="bg-surface-card rounded-[--radius-card] border border-surface-border p-6">
                            <TerminationHistory contractId={id} />
                        </div>
                    </div>

                    {/* Right Column - Sidebar */}
                    <div className="space-y-6">
                        {/* Quick Stats */}
                        <div className="bg-surface-card rounded-[--radius-card] border border-surface-border p-5">
                            <h3 className="text-base font-bold text-text-heading mb-4">{t('overviewHeading')}</h3>
                            <div className="space-y-4">
                                <div className="flex items-center justify-between p-3 bg-status-info-bg/30 rounded-[--radius-button]">
                                    <div className="flex items-center gap-2">
                                        <FileText size={16} className="text-status-info" />
                                        <span className="text-sm text-text-body">{t('contractType')}</span>
                                    </div>
                                    <span className="text-sm font-bold text-text-heading">{getContractTypeLabel(contract.contractType)}</span>
                                </div>
                                <div className="flex items-center justify-between p-3 bg-status-success-bg/30 rounded-[--radius-button]">
                                     <div className="flex items-center gap-2">
                                        <CurrencyIcon size={16} className="text-status-success" />
                                        <span className="text-sm text-text-body">{t('salary')}</span>
                                    </div>
                                    <span className="text-sm font-bold text-status-success">{formatCurrency(contract.salary)}</span>
                                </div>
                                <div className="flex items-center justify-between p-3 bg-brand-primary-light/20 rounded-[--radius-button]">
                                    <div className="flex items-center gap-2">
                                        <Briefcase size={16} className="text-brand-primary" />
                                        <span className="text-sm text-text-body">{t('appearanceLabel')}</span>
                                    </div>
                                    <span className="text-sm font-bold text-text-heading">{getWorkTypeLabel(contract.workType || 'FULL_TIME')}</span>
                                </div>
                                {contract.status === 'ACTIVE' && (
                                    <div className="flex items-center justify-between p-3 bg-status-success-bg/30 rounded-[--radius-button]">
                                        <div className="flex items-center gap-2">
                                            <CheckCircle2 size={16} className="text-status-success" />
                                            <span className="text-sm text-text-body">{tc('status')}</span>
                                        </div>
                                        <span className="text-sm font-bold text-status-success">{t('statusActive')}</span>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Timeline */}
                        <div className="bg-surface-card rounded-[--radius-card] border border-surface-border p-5">
                            <div className="flex items-center gap-2 mb-4">
                                <History size={18} className="text-text-muted" />
                                <h3 className="text-base font-bold text-text-heading">{t('historyHeading')}</h3>
                            </div>
                            <div className="space-y-4">
                                <div className="flex gap-3">
                                    <div className="flex flex-col items-center">
                                        <div className="w-8 h-8 rounded-full bg-status-info-bg flex items-center justify-center flex-shrink-0">
                                            <CheckCircle2 size={14} className="text-status-info" />
                                        </div>
                                        {contract.updatedAt !== contract.createdAt && (
                                            <div className="w-0.5 h-full bg-surface-border my-1"></div>
                                        )}
                                    </div>
                                    <div className="pb-4">
                                        <p className="text-sm font-bold text-text-heading">{t('contractCreated')}</p>
                                        <p className="text-xs text-text-muted mt-1">{formatDate(contract.createdAt)}</p>
                                    </div>
                                </div>
                                {contract.updatedAt !== contract.createdAt && (
                                    <div className="flex gap-3">
                                        <div className="w-8 h-8 rounded-full bg-surface-page flex items-center justify-center flex-shrink-0 border border-surface-border">
                                            <Edit size={14} className="text-text-muted" />
                                        </div>
                                        <div>
                                            <p className="text-sm font-bold text-text-heading">{t('lastUpdated')}</p>
                                            <p className="text-xs text-text-muted mt-1">{formatDate(contract.updatedAt)}</p>
                                        </div>
                                    </div>
                                )}
                                {contract.status === 'TERMINATED' && contract.terminatedReason && (
                                    <div className="flex gap-3">
                                        <div className="w-8 h-8 rounded-full bg-status-error-bg flex items-center justify-center flex-shrink-0">
                                            <XCircle size={14} className="text-status-error" />
                                        </div>
                                        <div>
                                            <p className="text-sm font-bold text-text-heading">{t('terminationReasonLabel')}</p>
                                            <p className="text-xs text-text-muted mt-1">{contract.terminatedReason}</p>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Actions */}
                        {contract.status === 'ACTIVE' && (
                            <div className="bg-surface-page rounded-[--radius-card] border border-surface-border p-5">
                                <h3 className="text-base font-bold text-text-heading mb-3">{t('actionHeading')}</h3>
                                {pendingTermination ? (
                                    <div className="space-y-3">
                                        <div className="bg-status-info-bg/40 border border-status-info/20 rounded-[--radius-button] p-3">
                                            <div className="flex items-center gap-2 mb-2">
                                                <Clock size={16} className="text-status-info" />
                                                <p className="text-sm font-bold text-status-info">{t('waitingForApproval')}</p>
                                            </div>
                                            <p className="text-xs text-status-info">
                                                {t('waitingForApprovalDesc')}
                                            </p>
                                        </div>
                                        <button onClick={() => router.push('/dashboard/contracts/terminations')} className="w-full px-4 py-2.5 bg-brand-primary text-text-on-brand rounded-[--radius-button] hover:bg-brand-primary-dark font-semibold transition-all text-sm flex items-center justify-center gap-2 cursor-pointer">
                                            {t('viewRequestStatus')}
                                        </button>
                                    </div>
                                ) : (
                                    <div className="space-y-3">
                                        <div className="bg-surface-card border border-surface-border rounded-[--radius-button] p-3">
                                            <p className="text-xs text-text-body">
                                                <span className="font-semibold">{t('noteLabel')}</span> {t('noteDesc')}
                                            </p>
                                        </div>
                                        <button data-testid="con-termreq-open" onClick={() => setShowTerminateModal(true)} disabled={loadingTermination} className="w-full px-4 py-2.5 bg-status-error text-text-on-brand rounded-[--radius-button] hover:bg-status-error/90 font-semibold transition-all text-sm flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer">
                                            <XCircle size={16} /> {t('requestTerminationBtn')}
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Terminate Modal */}
            {showTerminateModal && (
                <div className="fixed inset-0 bg-black/65 backdrop-blur-xs flex items-center justify-center p-4" style={{ zIndex: 9999 }}>
                    <div className="bg-surface-card rounded-[--radius-card] p-6 max-w-2xl w-full shadow-2xl max-h-[90vh] overflow-y-auto relative border border-surface-border">
                        <h3 className="text-xl font-bold text-text-heading mb-4">{t('terminationRequestModalTitle')}</h3>
                        <TerminationRequestForm
                            contractId={id}
                            userId={user?.id || ''}
                            onSuccess={() => {
                                setShowTerminateModal(false);
                                fetchContract();
                                checkPendingTermination();
                            }}
                            onCancel={() => setShowTerminateModal(false)}
                        />
                    </div>
                </div>
            )}
        </ProtectedRoute>
    );
}

'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import ClearanceBanner from '@/components/assets/ClearanceBanner';
import { terminationRequestService } from '@/services/terminationRequestService';
import { TerminationRequest, TERMINATION_CATEGORY_LABELS } from '@/types/termination-request';
import { toast } from '@/lib/toast';
import { formatDate } from '@/utils/formatDate';
import { FileText, Flame, CheckCircle, XCircle, Calendar, Clock, Building2, User } from 'lucide-react';
import { getApiErrorMessage } from '@/lib/apiError';

interface TerminationApprovalPanelProps {
    userId: string;
    onUpdate?: (action?: 'approved' | 'rejected') => void;
    urgentOnly?: boolean;
}

export default function TerminationApprovalPanel({ userId, onUpdate, urgentOnly = false }: TerminationApprovalPanelProps) {
    const t = useTranslations('terminationApprovalPanel');
    const tc = useTranslations('common');
    const [requests, setRequests] = useState<TerminationRequest[]>([]);
    const [loading, setLoading] = useState(true);
    const [selectedRequest, setSelectedRequest] = useState<TerminationRequest | null>(null);
    const [actionLoading, setActionLoading] = useState(false);
    const [approveComments, setApproveComments] = useState('');
    const [rejectReason, setRejectReason] = useState('');
    const [showApproveModal, setShowApproveModal] = useState(false);
    const [showRejectModal, setShowRejectModal] = useState(false);
    /**
     * Which employees clearance is currently blocking, keyed by employee id.
     *
     * `ClearanceBanner` already asks the server per row and reports back through
     * `onStatus`; this is the only place the approve modal can learn the answer
     * without asking a second time.
     */
    const [clearanceBlockedBy, setClearanceBlockedBy] = useState<Record<string, boolean>>({});
    /** The audited reason. Typed on purpose, never defaulted — see handleApprove. */
    const [clearanceOverrideReason, setClearanceOverrideReason] = useState('');

    const selectedEmployeeId = selectedRequest?.contract?.employee?.id;
    const clearanceBlocked = !!selectedEmployeeId && clearanceBlockedBy[selectedEmployeeId] === true;

    useEffect(() => {
        fetchPendingRequests();
    }, []);

    const fetchPendingRequests = async () => {
        try {
            const data = await terminationRequestService.getPendingTerminations();
            setRequests(data || []);
        } catch (error) {
            console.error('Failed to fetch termination requests:', error);
            toast.error(t('loadFailed'));
            setRequests([]); // Set empty array on error
        } finally {
            setLoading(false);
        }
    };

    const handleApprove = async () => {
        if (!selectedRequest) return;
        // The override is audited as CLEARANCE_OVERRIDDEN, so it has to be a
        // deliberate act: no default text, and no approval at all while
        // clearance blocks and the box is empty. Refused here rather than left
        // to the server, which would answer the same 400 the banner already
        // warned about — with the reason the approver typed thrown away.
        if (clearanceBlocked && !clearanceOverrideReason.trim()) {
            toast.error(t('enterClearanceOverrideReason'));
            return;
        }
        setActionLoading(true);

        try {
            await terminationRequestService.approveTermination(selectedRequest.id, {
                approverId: userId,
                comments: approveComments,
                // Sent only while clearance is actually blocking: an override
                // reason on an approval that needed none would be recorded as an
                // override that never happened.
                ...(clearanceBlocked
                    ? { clearanceOverrideReason: clearanceOverrideReason.trim() }
                    : {}),
            });
            toast.success(t('approveSuccess'));
            setShowApproveModal(false);
            setApproveComments('');
            setClearanceOverrideReason('');
            fetchPendingRequests();
            onUpdate?.('approved');
        } catch (error: any) {
            toast.error(getApiErrorMessage(error, t('approveFailed')));
        } finally {
            setActionLoading(false);
        }
    };

    const handleReject = async () => {
        if (!selectedRequest || !rejectReason.trim()) {
            toast.error(t('enterRejectReason'));
            return;
        }
        setActionLoading(true);

        try {
            await terminationRequestService.rejectTermination(selectedRequest.id, {
                approverId: userId,
                reason: rejectReason,
            });
            toast.success(t('rejectSuccess'));
            setShowRejectModal(false);
            setRejectReason('');
            fetchPendingRequests();
            onUpdate?.('rejected');
        } catch (error: any) {
            toast.error(getApiErrorMessage(error, t('rejectFailed')));
        } finally {
            setActionLoading(false);
        }
    };

    const calculateDaysRemaining = (terminationDate: string) => {
        const today = new Date();
        const termDate = new Date(terminationDate);
        const diffTime = termDate.getTime() - today.getTime();
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        return diffDays;
    };

    if (loading) {
        return (
            <div className="space-y-4">
                {[1, 2, 3].map((i) => (
                    <div key={i} className="border border-surface-border rounded-[--radius-card] p-6 bg-surface-card animate-pulse">
                        <div className="flex justify-between items-start mb-4">
                            <div className="flex-1">
                                <div className="h-5 bg-surface-border rounded w-1/3 mb-2"></div>
                                <div className="h-4 bg-surface-border-light rounded w-1/2 mb-1"></div>
                                <div className="h-4 bg-surface-border-light rounded w-1/4"></div>
                            </div>
                            <div className="h-6 bg-surface-border rounded-[--radius-badge] w-20"></div>
                        </div>
                        <div className="grid grid-cols-4 gap-4 mb-4">
                            <div className="h-4 bg-surface-border-light rounded"></div>
                            <div className="h-4 bg-surface-border-light rounded"></div>
                            <div className="h-4 bg-surface-border-light rounded"></div>
                            <div className="h-4 bg-surface-border-light rounded"></div>
                        </div>
                        <div className="h-12 bg-surface-border-light rounded mb-4"></div>
                        <div className="flex justify-end gap-3">
                            <div className="h-10 bg-surface-border rounded-[--radius-button] w-24"></div>
                            <div className="h-10 bg-surface-border rounded-[--radius-button] w-24"></div>
                        </div>
                    </div>
                ))}
            </div>
        );
    }

    if (!requests || requests.length === 0) {
        return (
            <div data-testid="term-empty" className="text-center py-12">
                <FileText className="w-16 h-16 text-text-muted/40 mx-auto mb-4" />
                <p className="text-text-muted font-medium mb-2">{t('noPendingRequests')}</p>
                <p className="text-text-muted text-sm">{t('allProcessed')}</p>
            </div>
        );
    }

    return (
        <div className="space-y-4">
            {requests.map((request) => {
                const daysRemaining = calculateDaysRemaining(request.terminationDate);
                const isUrgent = daysRemaining <= 7;

                // Apply urgent filter
                if (urgentOnly && !isUrgent) {
                    return null;
                }

                return (
                    <div
                        key={request.id}
                        data-testid={`term-row-${request.id}`}
                        className={`border-2 rounded-[--radius-card] p-6 transition-all hover:shadow-lg ${isUrgent
                            ? 'border-status-error/30 bg-gradient-to-br from-status-error-bg to-status-error-bg/80'
                            : 'border-surface-border bg-surface-card hover:border-brand-primary/50'
                            }`}
                    >
                        <div className="flex justify-between items-start mb-4">
                            <div className="flex items-start gap-3">
                                <div className={`w-10 h-10 rounded-[--radius-card] flex items-center justify-center ${isUrgent ? 'bg-status-error-bg' : 'bg-brand-primary-light/20'
                                    }`}>
                                    <User className={isUrgent ? 'text-status-error' : 'text-brand-primary'} size={20} />
                                </div>
                                <div>
                                    <h3 className="text-lg font-bold text-text-heading">
                                        {request.contract?.employee.fullName}
                                    </h3>
                                    <p className="text-sm text-text-body font-medium">
                                        {request.contract?.employee.employeeCode} • {request.contract?.employee.position}
                                    </p>
                                    <div className="flex items-center gap-1 text-sm text-text-muted mt-1">
                                        <Building2 size={14} />
                                        {request.contract?.employee.department?.name}
                                    </div>
                                </div>
                            </div>
                            {isUrgent && (
                                <span className="flex items-center gap-1 px-3 py-1 bg-status-error text-text-on-brand text-xs font-bold rounded-[--radius-badge] shadow-lg">
                                    <Flame size={14} />
                                    {t('urgent')}
                                </span>
                            )}
                        </div>

                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4 p-4 bg-surface-border-light rounded-[--radius-card] border border-surface-border">
                            <div>
                                <p className="text-xs text-text-muted font-semibold mb-1 flex items-center gap-1">
                                    <FileText size={12} />
                                    {t('terminationTypeLabel')}
                                </p>
                                <p className="text-sm font-bold text-text-heading">
                                    {TERMINATION_CATEGORY_LABELS[request.terminationCategory]}
                                </p>
                            </div>
                            <div>
                                <p className="text-xs text-text-muted font-semibold mb-1 flex items-center gap-1">
                                    <Calendar size={12} />
                                    {t('announcementDateLabel')}
                                </p>
                                <p className="text-sm font-bold text-text-heading">
                                    {formatDate(request.noticeDate)}
                                </p>
                            </div>
                            <div>
                                <p className="text-xs text-text-muted font-semibold mb-1 flex items-center gap-1">
                                    <Calendar size={12} />
                                    {t('terminationDateLabel')}
                                </p>
                                <p className="text-sm font-bold text-text-heading">
                                    {formatDate(request.terminationDate)}
                                </p>
                            </div>
                            <div>
                                <p className="text-xs text-text-muted font-semibold mb-1 flex items-center gap-1">
                                    <Clock size={12} />
                                    {t('remainingLabel')}
                                </p>
                                <p className={`text-sm font-bold ${isUrgent ? 'text-status-error' : 'text-text-heading'}`}>
                                    {t('daysRemaining', { count: daysRemaining ?? 0 })}
                                </p>
                            </div>
                        </div>

                        <div className="mb-4 p-4 bg-surface-border-light rounded-[--radius-card] border border-surface-border">
                            <p className="text-xs text-text-muted font-semibold mb-2">{t('terminationReasonLabel')}</p>
                            <p className="text-sm text-text-body leading-relaxed">{request.reason}</p>
                        </div>

                        {/* Approval is blocked server-side while assets are outstanding;
                            surface that here so it is not discovered on click. */}
                        {request.contract?.employee?.id && (
                            <div className="mb-4">
                                <div data-testid={`term-clearance-banner-${request.id}`}>
                                    <ClearanceBanner
                                        employeeId={request.contract.employee.id}
                                        // Remember the verdict per employee so the approve modal
                                        // knows whether an override is needed. Returning `prev`
                                        // unchanged keeps a repeat answer from re-rendering the
                                        // whole list.
                                        onStatus={(status) => {
                                            const id = request.contract!.employee.id;
                                            setClearanceBlockedBy((prev) =>
                                                prev[id] === !status.cleared
                                                    ? prev
                                                    : { ...prev, [id]: !status.cleared },
                                            );
                                        }}
                                    />
                                </div>
                            </div>
                        )}

                        <div className="flex justify-end gap-3">
                            <button
                                data-testid={`term-reject-${request.id}`}
                                onClick={() => {
                                    setSelectedRequest(request);
                                    setShowRejectModal(true);
                                }}
                                className="flex items-center gap-2 px-5 py-2.5 border-2 border-status-error/30 text-status-error rounded-[--radius-button] hover:bg-status-error-bg hover:border-status-error/50 transition-all font-semibold"
                            >
                                <XCircle size={18} />
                                {t('reject')}
                            </button>
                            <button
                                data-testid={`term-approve-${request.id}`}
                                onClick={() => {
                                    setSelectedRequest(request);
                                    setShowApproveModal(true);
                                }}
                                className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-status-success to-status-success/80 text-text-on-brand rounded-[--radius-button] hover:shadow-xl hover:scale-105 transition-all font-semibold shadow-lg"
                            >
                                <CheckCircle size={18} />
                                {t('approve')}
                            </button>
                        </div>
                    </div>
                );
            })}

            {/* Approve Modal */}
            {showApproveModal && selectedRequest && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" style={{ zIndex: 9999 }}>
                    <div className="bg-surface-overlay rounded-[--radius-card] p-6 max-w-md w-full shadow-2xl">
                        <h3 className="text-lg font-semibold text-text-heading mb-4">{t('approveModalTitle')}</h3>
                        <p className="text-sm text-text-muted mb-4">
                            {t('confirmApproveDesc', { name: selectedRequest.contract?.employee.fullName ?? '' })}
                        </p>
                        <div className="mb-4">
                            <label className="block text-sm font-medium text-text-body mb-2">
                                {t('notesOptional')}
                            </label>
                            <textarea
                                value={approveComments}
                                onChange={(e) => setApproveComments(e.target.value)}
                                rows={3}
                                placeholder={t('notesPlaceholder')}
                                className="w-full px-4 py-2 border border-surface-border rounded-[--radius-input] focus:ring-2 focus:ring-status-success focus:border-transparent resize-none bg-surface-card text-text-body"
                            />
                        </div>
                        {/* Only while clearance actually blocks. The banner tells the
                            approver an override is possible; this is where it is
                            supplied, and it reaches the server as
                            `clearanceOverrideReason` on ApproveTerminationDto. */}
                        {clearanceBlocked && (
                            <div className="mb-4" data-testid="term-clearance-override">
                                <label className="block text-sm font-medium text-text-body mb-2">
                                    {t('clearanceOverrideReasonLabel')} <span className="text-status-error">*</span>
                                </label>
                                <textarea
                                    data-testid="term-clearance-override-reason"
                                    value={clearanceOverrideReason}
                                    onChange={(e) => setClearanceOverrideReason(e.target.value)}
                                    rows={3}
                                    required
                                    placeholder={t('clearanceOverrideReasonPlaceholder')}
                                    className="w-full px-4 py-2 border border-surface-border rounded-[--radius-input] focus:ring-2 focus:ring-status-error focus:border-transparent resize-none bg-surface-card text-text-body"
                                />
                                <p className="mt-2 text-xs text-text-muted">{t('clearanceOverrideHint')}</p>
                            </div>
                        )}
                        <div className="flex justify-end gap-3">
                            <button
                                onClick={() => {
                                    setShowApproveModal(false);
                                    setApproveComments('');
                                    setClearanceOverrideReason('');
                                }}
                                disabled={actionLoading}
                                className="px-4 py-2 border border-surface-border rounded-[--radius-button] text-text-body hover:bg-surface-border-light"
                            >
                                {tc('cancel')}
                            </button>
                            <button
                                data-testid="term-approve-confirm"
                                onClick={handleApprove}
                                // Same rule as the reject modal: a required reason
                                // disables the button rather than failing on click.
                                disabled={actionLoading || (clearanceBlocked && !clearanceOverrideReason.trim())}
                                className="px-4 py-2 bg-status-success text-text-on-brand rounded-[--radius-button] hover:bg-status-success/90 disabled:opacity-50"
                            >
                                {actionLoading ? t('processing') : t('confirmApproval')}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Reject Modal */}
            {showRejectModal && selectedRequest && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" style={{ zIndex: 9999 }}>
                    <div className="bg-surface-overlay rounded-[--radius-card] p-6 max-w-md w-full shadow-2xl">
                        <h3 className="text-lg font-semibold text-text-heading mb-4">{t('rejectModalTitle')}</h3>
                        <p className="text-sm text-text-muted mb-4">
                            {t('enterRejectionReasonFor', { name: selectedRequest.contract?.employee.fullName ?? '' })}
                        </p>
                        <div className="mb-4">
                            <label className="block text-sm font-medium text-text-body mb-2">
                                {t('rejectionReasonLabel')} <span className="text-status-error">*</span>
                            </label>
                            <textarea
                                data-testid="term-reject-reason"
                                value={rejectReason}
                                onChange={(e) => setRejectReason(e.target.value)}
                                rows={3}
                                required
                                placeholder={t('rejectionReasonPlaceholder')}
                                className="w-full px-4 py-2 border border-surface-border rounded-[--radius-input] focus:ring-2 focus:ring-status-error focus:border-transparent resize-none bg-surface-card text-text-body"
                            />
                        </div>
                        <div className="flex justify-end gap-3">
                            <button
                                onClick={() => {
                                    setShowRejectModal(false);
                                    setRejectReason('');
                                }}
                                disabled={actionLoading}
                                className="px-4 py-2 border border-surface-border rounded-[--radius-button] text-text-body hover:bg-surface-border-light"
                            >
                                {tc('cancel')}
                            </button>
                            <button
                                data-testid="term-reject-confirm"
                                onClick={handleReject}
                                disabled={actionLoading || !rejectReason.trim()}
                                className="px-4 py-2 bg-status-error text-text-on-brand rounded-[--radius-button] hover:bg-status-error/90 disabled:opacity-50"
                            >
                                {actionLoading ? t('processing') : t('confirmRejection')}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

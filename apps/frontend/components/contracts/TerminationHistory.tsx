'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { terminationRequestService } from '@/services/terminationRequestService';
import { TerminationRequest, TERMINATION_CATEGORY_LABELS } from '@/types/termination-request';
import { formatDate } from '@/utils/formatDate';

interface TerminationHistoryProps {
    contractId?: string;
}

export default function TerminationHistory({ contractId }: TerminationHistoryProps) {
    const t = useTranslations('terminationHistory');
    const tc = useTranslations('common');
    const [requests, setRequests] = useState<TerminationRequest[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetchTerminationHistory();
    }, [contractId]);

    const fetchTerminationHistory = async () => {
        try {
            const data = contractId
                ? await terminationRequestService.getTerminationRequestsByContract(contractId)
                : await terminationRequestService.getTerminationHistory();
            setRequests(data || []);
        } catch (error) {
            console.error('Failed to fetch termination history:', error);
            setRequests([]);
        } finally {
            setLoading(false);
        }
    };

    const getStatusBadge = (status: string) => {
        switch (status) {
            case 'PENDING_APPROVAL':
                return (
                    <span className="px-3 py-1 bg-status-warning-bg text-status-warning text-xs font-semibold rounded-[--radius-badge]">
                        {t('statusPending')}
                    </span>
                );
            case 'APPROVED':
                return (
                    <span className="px-3 py-1 bg-status-success-bg text-status-success text-xs font-semibold rounded-[--radius-badge]">
                        {t('statusApproved')}
                    </span>
                );
            case 'REJECTED':
                return (
                    <span className="px-3 py-1 bg-status-error-bg text-status-error text-xs font-semibold rounded-[--radius-badge]">
                        {t('statusRejected')}
                    </span>
                );
            default:
                return null;
        }
    };

    if (loading) {
        return (
            <div>
                <h3 className="text-lg font-semibold text-text-heading mb-4">{t('title')}</h3>
                <div className="space-y-4">
                    {[1, 2].map((i) => (
                        <div key={i} className="border border-surface-border rounded-[--radius-card] p-4 bg-surface-card animate-pulse">
                            <div className="flex justify-between items-start mb-3">
                                <div className="flex-1">
                                    <div className="h-4 bg-surface-border rounded w-1/3 mb-2"></div>
                                    <div className="h-3 bg-surface-border-light rounded w-1/4"></div>
                                </div>
                                <div className="h-6 bg-surface-border rounded-[--radius-badge] w-24"></div>
                            </div>
                            <div className="grid grid-cols-2 gap-3 mb-3">
                                <div className="h-3 bg-surface-border-light rounded"></div>
                                <div className="h-3 bg-surface-border-light rounded"></div>
                            </div>
                            <div className="h-12 bg-surface-border-light rounded"></div>
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    if (!requests || requests.length === 0) {
        return (
            <div className="text-center py-8 text-text-muted">
                <p>{t('noRequests')}</p>
            </div>
        );
    }

    return (
        <div className="space-y-4">
            <h3 className="text-lg font-semibold text-text-heading mb-4">{t('title')}</h3>
            {requests.map((request) => (
                <div key={request.id} className="border border-surface-border rounded-[--radius-card] p-4 bg-surface-card">
                    <div className="flex justify-between items-start mb-3">
                        <div>
                            {!contractId && request.contract?.employee && (
                                <p className="text-sm font-semibold text-text-heading">
                                    {request.contract.employee.fullName}
                                    <span className="text-text-muted font-normal">
                                        {' '}• {request.contract.employee.employeeCode}
                                    </span>
                                </p>
                            )}
                            <p className="text-sm font-medium text-text-heading">
                                {TERMINATION_CATEGORY_LABELS[request.terminationCategory]}
                            </p>
                            <p className="text-xs text-text-muted">
                                {t('createDatePrefix')}{formatDate(request.createdAt)}
                            </p>
                        </div>
                        {getStatusBadge(request.status)}
                    </div>

                    <div className="grid grid-cols-2 gap-3 mb-3">
                        <div>
                            <p className="text-xs text-text-muted">{t('announcementDateLabel')}</p>
                            <p className="text-sm text-text-heading">{formatDate(request.noticeDate)}</p>
                        </div>
                        <div>
                            <p className="text-xs text-text-muted">{t('terminationDateLabel')}</p>
                            <p className="text-sm text-text-heading">{formatDate(request.terminationDate)}</p>
                        </div>
                    </div>

                    <div className="mb-3">
                        <p className="text-xs text-text-muted mb-1">{tc('reason')}</p>
                        <p className="text-sm text-text-body">{request.reason}</p>
                    </div>

                    {request.requester && (
                        <div className="mb-2">
                            <p className="text-xs text-text-muted">{t('requesterLabel')}</p>
                            <p className="text-sm text-text-body">{request.requester.email}</p>
                        </div>
                    )}

                    {request.status === 'APPROVED' && request.approver && (
                        <div className="border-t border-surface-border pt-3 mt-3">
                            <p className="text-xs text-text-muted mb-1">{t('approvedByLabel')}</p>
                            <p className="text-sm text-text-body">{request.approver.email}</p>
                            {request.approvedAt && (
                                <p className="text-xs text-text-muted">
                                    {t('approvalDatePrefix')}{formatDate(request.approvedAt)}
                                </p>
                            )}
                            {request.approverComments && (
                                <div className="mt-2">
                                    <p className="text-xs text-text-muted">{tc('notes')}</p>
                                    <p className="text-sm text-text-body">{request.approverComments}</p>
                                </div>
                            )}
                        </div>
                    )}

                    {request.status === 'REJECTED' && request.approver && (
                        <div className="border-t border-status-error/20 pt-3 mt-3 bg-status-error-bg -mx-4 -mb-4 px-4 pb-4 rounded-b-[--radius-card]">
                            <p className="text-xs text-status-error mb-1">{t('rejectedByLabel')}</p>
                            <p className="text-sm text-status-error">{request.approver.email}</p>
                            {request.approvedAt && (
                                <p className="text-xs text-status-error">
                                    {t('rejectionDatePrefix')}{formatDate(request.approvedAt)}
                                </p>
                            )}
                            {request.rejectionReason && (
                                <div className="mt-2">
                                    <p className="text-xs text-status-error">{t('rejectionReasonLabel')}</p>
                                    <p className="text-sm text-status-error">{request.rejectionReason}</p>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            ))}
        </div>
    );
}

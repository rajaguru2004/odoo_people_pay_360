'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import PageActionRow from '@/components/common/PageActionRow';
import { Clock, CheckCircle, XCircle, AlertCircle, Calendar, Paperclip } from 'lucide-react';
import { motion } from 'framer-motion';
import leaveService from '@/services/leaveService';
import { LeaveRequest } from '@/types/leave';
import { useBrandingStore } from '@/store/brandingStore';
import { formatDate } from '@/utils/formatters';

export default function PendingLeavesPage() {
    const router = useRouter();
    const t = useTranslations('pendingPage');
    const tc = useTranslations('common');

    // The one heading for this route, rendered by TopHeader.
    usePageHeader(t('title'), t('subtitle'));

    const [requests, setRequests] = useState<LeaveRequest[]>([]);
    const [loading, setLoading] = useState(true);
    const { branding } = useBrandingStore();
    const hierarchyEnabled = branding.leave_approval_hierarchy_enabled;

    useEffect(() => {
        fetchPendingRequests();
    }, []);

    const fetchPendingRequests = async () => {
        try {
            setLoading(true);
            const response = await leaveService.getPending();
            setRequests(response.data);
        } catch (error) {
            console.error('Failed to fetch pending requests:', error);
        } finally {
            setLoading(false);
        }
    };

    const getLeaveTypeLabel = (type: string) => {
        const labels: Record<string, string> = {
            ANNUAL: tc('annualLeave'),
            SICK: tc('sickLeave'),
            UNPAID: tc('unpaidLeave'),
            MATERNITY: tc('maternityLeave'),
            PATERNITY: tc('paternityLeave'),
            BEREAVEMENT: tc('bereavementLeave'),
        };
        return labels[type.toUpperCase()] || type;
    };

    return (
        <ProtectedRoute requiredPermission="VIEW_ALL_LEAVES">
            <>
                <div className="space-y-6">
                    {/* Pending counter. The title/description live in the sticky
                        TopHeader (declared via usePageHeader above). */}
                    <PageActionRow
                        action={
                            <div className="flex items-center gap-2 px-4 py-2 bg-status-warning-bg border-2 border-status-warning/20 rounded-[--radius-card]">
                                <Clock className="text-status-warning" size={20} />
                                <span
                                    data-testid="lvp-count"
                                    data-count={requests.length}
                                    className="font-bold text-status-warning"
                                >
                                    {t('pendingApprovalCount', { count: requests.length })}
                                </span>
                            </div>
                        }
                    />

                    {/* Pending Requests */}
                    <div className="bg-surface-card rounded-[--radius-card] border border-surface-border">
                        {loading ? (
                            <div data-testid="lvp-loading" className="p-12 text-center">
                                <div className="inline-block w-8 h-8 border-4 border-brand-primary border-t-transparent rounded-full animate-spin"></div>
                                <p className="text-text-muted mt-4">{tc('loading')}</p>
                            </div>
                        ) : requests.length === 0 ? (
                            <div data-testid="lvp-empty" className="p-12 text-center">
                                <CheckCircle className="w-16 h-16 text-status-success mx-auto mb-4" />
                                <p className="text-text-muted text-lg">{t('noApprovalsPending')}</p>
                            </div>
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="w-full">
                                    <thead className="bg-surface-page border-b border-surface-border">
                                        <tr>
                                            <th className="px-6 py-3 text-start text-xs font-medium text-text-muted uppercase tracking-wider">
                                                {tc('employee')}
                                            </th>
                                            <th className="px-6 py-3 text-start text-xs font-medium text-text-muted uppercase tracking-wider">
                                                📎
                                            </th>
                                            <th className="px-6 py-3 text-start text-xs font-medium text-text-muted uppercase tracking-wider">
                                                {tc('leaveTypeLabel')}
                                            </th>
                                            <th className="px-6 py-3 text-start text-xs font-medium text-text-muted uppercase tracking-wider">
                                                {tc('startDate')}
                                            </th>
                                            <th className="px-6 py-3 text-start text-xs font-medium text-text-muted uppercase tracking-wider">
                                                {tc('endDate')}
                                            </th>
                                            <th className="px-6 py-3 text-start text-xs font-medium text-text-muted uppercase tracking-wider">
                                                {tc('totalDays')}
                                            </th>
                                            {hierarchyEnabled && (
                                                <th className="px-6 py-3 text-start text-xs font-medium text-text-muted uppercase tracking-wider">
                                                    {t('stageHeader')}
                                                </th>
                                            )}
                                            <th className="px-6 py-3 text-start text-xs font-medium text-text-muted uppercase tracking-wider">
                                                {tc('reason')}
                                            </th>
                                            <th className="px-6 py-3 text-start text-xs font-medium text-text-muted uppercase tracking-wider">
                                                {t('creationDate')}
                                            </th>
                                            <th className="px-6 py-3 text-start text-xs font-medium text-text-muted uppercase tracking-wider">
                                                {tc('actions')}
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-surface-border">
                                        {requests.map((request, index) => {
                                            const approvedTiers = request.approvals?.filter((a: any) => a.status === 'APPROVED').map((a: any) => a.tier) || [];
                                            const nextTier = !approvedTiers.includes(1) ? 1 : !approvedTiers.includes(2) ? 2 : 3;
                                            const stageNames = { 1: t('stageDeptHead'), 2: t('stageHrManager'), 3: t('stageAdmin') };

                                            return (
                                                <motion.tr
                                                    key={request.id}
                                                    data-testid="lvp-row"
                                                    data-leave-id={request.id}
                                                    data-total-days={request.totalDays}
                                                    data-attachments={request.attachments?.length ?? 0}
                                                    initial={{ opacity: 0 }}
                                                    animate={{ opacity: 1 }}
                                                    transition={{ delay: index * 0.05 }}
                                                    className="hover:bg-surface-page transition-colors"
                                                >
                                                    <td className="px-6 py-4">
                                                        <div className="flex items-center gap-2">
                                                            <div className="w-8 h-8 rounded-full bg-brand-primary-light/20 flex items-center justify-center text-brand-primary font-semibold text-xs">
                                                                {request.employee?.fullName?.split(' ').map(n => n[0]).join('').slice(0, 2) || 'NA'}
                                                            </div>
                                                            <div>
                                                                <p className="text-sm font-medium text-text-heading">{request.employee?.fullName || tc('notAvailable')}</p>
                                                                <p className="text-xs text-text-muted">{request.employee?.employeeCode || ''}</p>
                                                            </div>
                                                        </div>
                                                    </td>
                                                    <td className="px-6 py-4">
                                                        {request.attachments && request.attachments.length > 0 ? (
                                                            <span data-testid="lvp-attachments" className="flex items-center text-text-muted" title={t('attachmentsCountTitle', { count: request.attachments.length })}>
                                                                <Paperclip size={16} className="me-1 text-text-muted" />
                                                                <span className="text-xs font-medium bg-surface-page px-1.5 py-0.5 rounded-full border border-surface-border">
                                                                  {request.attachments.length}
                                                                </span>
                                                            </span>
                                                        ) : (
                                                            <span className="text-xs text-text-muted">-</span>
                                                        )}
                                                    </td>
                                                    <td className="px-6 py-4">
                                                        <span className="text-sm font-medium text-text-heading">
                                                            {getLeaveTypeLabel(request.leaveType)}
                                                        </span>
                                                    </td>
                                                    <td className="px-6 py-4 text-sm text-text-body">{formatDate(request.startDate)}</td>
                                                    <td className="px-6 py-4 text-sm text-text-body">{formatDate(request.endDate)}</td>
                                                    <td className="px-6 py-4">
                                                        <span className="text-sm font-semibold text-brand-primary">{request.totalDays}</span>
                                                    </td>
                                                    {hierarchyEnabled && (
                                                        <td className="px-6 py-4">
                                                            <span
                                                                data-testid="lvp-stage"
                                                                data-tier={nextTier}
                                                                className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-brand-primary-light/10 text-brand-primary border border-brand-primary/20"
                                                            >
                                                                {t('stageBadge', { tier: nextTier, stageName: stageNames[nextTier as 1 | 2 | 3] })}
                                                            </span>
                                                        </td>
                                                    )}
                                                    <td className="px-6 py-4">
                                                        <p className="text-sm text-text-body line-clamp-1 max-w-xs">{request.reason}</p>
                                                    </td>
                                                    <td className="px-6 py-4 text-sm text-text-muted">
                                                        {formatDate(request.createdAt)}
                                                    </td>
                                                    <td className="px-6 py-4">
                                                        <button
                                                            data-testid="lvp-open"
                                                            onClick={() => router.push(`/dashboard/leaves/${request.id}`)}
                                                            className="px-4 py-2 bg-brand-primary text-text-on-brand rounded-[--radius-button] hover:bg-brand-primary-dark transition-colors text-sm font-medium"
                                                        >
                                                            {t('viewAndBrowse')}
                                                        </button>
                                                    </td>
                                                </motion.tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>
                </div>
            </>
        </ProtectedRoute>
    );
}

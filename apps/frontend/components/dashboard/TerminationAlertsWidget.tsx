'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { terminationRequestService } from '@/services/terminationRequestService';
import { TerminationRequest, TERMINATION_CATEGORY_LABELS } from '@/types/termination-request';
import { formatDate } from '@/utils/formatDate';
import { AlertTriangle, Clock, ArrowRight } from 'lucide-react';

export default function TerminationAlertsWidget() {
    const router = useRouter();
    const [requests, setRequests] = useState<TerminationRequest[]>([]);
    const [loading, setLoading] = useState(true);
    const [urgentCount, setUrgentCount] = useState(0);

    useEffect(() => {
        fetchPendingRequests();
    }, []);

    const fetchPendingRequests = async () => {
        try {
            const data = await terminationRequestService.getPendingTerminations();
            const requestsData = data || [];
            setRequests(requestsData.slice(0, 3)); // Show only top 3

            // Count urgent requests (≤7 days)
            const urgent = requestsData.filter((req) => {
                const daysRemaining = calculateDaysRemaining(req.terminationDate);
                return daysRemaining <= 7;
            });
            setUrgentCount(urgent.length);
        } catch (error) {
            console.error('Failed to fetch termination requests:', error);
            setRequests([]); // Set empty array on error
            setUrgentCount(0);
        } finally {
            setLoading(false);
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
            <div className="bg-surface-card rounded-[--radius-card] border border-surface-border p-6 shadow-sm">
                <div className="animate-pulse">
                    <div className="h-5 bg-surface-border-light rounded w-1/3 mb-4"></div>
                    <div className="space-y-3">
                        <div className="h-16 bg-surface-border-light rounded"></div>
                        <div className="h-16 bg-surface-border-light rounded"></div>
                    </div>
                </div>
            </div>
        );
    }

    if (!requests || requests.length === 0) {
        return (
            <div className="bg-surface-card rounded-[--radius-card] border border-surface-border p-6 shadow-sm">
                <div className="flex items-center justify-between mb-4">
                    <h3 className="text-lg font-bold text-text-heading">Request to terminate the contract</h3>
                    <span className="px-3 py-1 bg-status-success-bg text-status-success text-xs font-semibold rounded-[--radius-badge]">
                        ✅ No requirements
                    </span>
                </div>
                <p className="text-sm text-text-muted">There are no termination requests pending approval</p>
            </div>
        );
    }

    return (
        <div className="bg-surface-card rounded-[--radius-card] border border-surface-border p-6 shadow-sm">
            <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                    <h3 className="text-lg font-bold text-text-heading">Request to terminate the contract</h3>
                    {urgentCount > 0 && (
                        <span className="px-2 py-1 bg-status-error-bg text-status-error text-xs font-bold rounded-[--radius-badge] flex items-center gap-1">
                            <AlertTriangle size={12} />
                            {urgentCount} urgent
                        </span>
                    )}
                </div>
                <button
                    onClick={() => router.push('/dashboard/contracts/terminations')}
                    className="text-brand-primary hover:text-brand-primary-dark text-sm font-semibold flex items-center gap-1"
                >
                    See all
                    <ArrowRight size={16} />
                </button>
            </div>

            <div className="space-y-3">
                {requests.map((request) => {
                    const daysRemaining = calculateDaysRemaining(request.terminationDate);
                    const isUrgent = daysRemaining <= 7;

                    return (
                        <div
                            key={request.id}
                            className={`border rounded-[--radius-button] p-4 cursor-pointer transition-all hover:shadow-md ${isUrgent
                                ? 'border-status-error/30 bg-status-error-bg hover:bg-status-error-bg/85'
                                : 'border-surface-border bg-surface-border-light hover:bg-surface-border'
                                }`}
                            onClick={() => router.push('/dashboard/contracts/terminations')}
                        >
                            <div className="flex items-start justify-between mb-2">
                                <div className="flex-1">
                                    <p className="font-semibold text-text-heading">
                                        {request.contract?.employee.fullName}
                                    </p>
                                    <p className="text-xs text-text-muted">
                                        {request.contract?.employee.employeeCode} • {request.contract?.employee.position}
                                    </p>
                                </div>
                                {isUrgent && (
                                    <span className="px-2 py-1 bg-status-error text-text-on-brand text-xs font-bold rounded-[--radius-badge]">
                                        🔥 Urgent
                                    </span>
                                )}
                            </div>

                            <div className="flex items-center justify-between text-xs">
                                <span className="text-text-muted">
                                    {TERMINATION_CATEGORY_LABELS[request.terminationCategory]}
                                </span>
                                <div className="flex items-center gap-1 text-text-body font-medium">
                                    <Clock size={12} />
                                    <span className={isUrgent ? 'text-status-error font-bold' : ''}>
                                        {daysRemaining} days
                                    </span>
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>

            {requests.length > 0 && (
                <button
                    onClick={() => router.push('/dashboard/contracts/terminations')}
                    className="w-full mt-4 px-4 py-2 bg-brand-primary text-text-on-brand rounded-[--radius-button] hover:bg-brand-primary-dark font-semibold text-sm transition-colors"
                >
                    Approve now ({requests.length})
                </button>
            )}
        </div>
    );
}

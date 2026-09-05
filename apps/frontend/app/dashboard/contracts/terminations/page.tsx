'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import TerminationApprovalPanel from '@/components/contracts/TerminationApprovalPanel';
import TerminationHistory from '@/components/contracts/TerminationHistory';
import { useAuthStore } from '@/store/authStore';
import { AlertCircle, Clock, Flame, CheckCircle, History } from 'lucide-react';
import { terminationRequestService } from '@/services/terminationRequestService';
import { usePageHeader } from '@/hooks/usePageHeader';

export default function TerminationManagementPage() {
    const t = useTranslations('terminationsPage');
    const { user } = useAuthStore();

    // The one heading for this route, rendered by TopHeader. Declared above the
    // permission-denial early-return so the hook order never changes.
    usePageHeader(t('title'), t('subtitle'));

    const [activeTab, setActiveTab] = useState<'pending' | 'history'>('pending');
    const [stats, setStats] = useState({
        pending: 0,
        urgent: 0,
        approvedThisMonth: 0,
    });
    const [loading, setLoading] = useState(true);
    const [showUrgentOnly, setShowUrgentOnly] = useState(false);

    useEffect(() => {
        if (user) {
            fetchStats();
        }
    }, [user]);

    const fetchStats = async () => {
        try {
            const pendingData = await terminationRequestService.getPendingTerminations();
            const pending = pendingData?.length || 0;

            // Calculate urgent (≤7 days)
            const urgent = pendingData?.filter((req: any) => {
                const daysRemaining = Math.ceil(
                    (new Date(req.terminationDate).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24)
                );
                return daysRemaining <= 7;
            }).length || 0;

            const historyData = await terminationRequestService.getTerminationHistory();
            const now = new Date();
            const approvedThisMonth = (historyData || []).filter((req: any) => {
                if (req.status !== 'APPROVED' || !req.approvedAt) return false;
                const approvedAt = new Date(req.approvedAt);
                return (
                    approvedAt.getMonth() === now.getMonth() &&
                    approvedAt.getFullYear() === now.getFullYear()
                );
            }).length;

            setStats({ pending, urgent, approvedThisMonth });
        } catch (error) {
            console.error('Failed to fetch stats:', error);
        } finally {
            setLoading(false);
        }
    };

    // Bump the stat cards immediately (before the follow-up network round trip
    // resolves), then reconcile with the server via fetchStats for correctness.
    const handleTerminationUpdate = (action?: 'approved' | 'rejected') => {
        if (action === 'approved') {
            setStats((prev) => ({
                ...prev,
                pending: Math.max(0, prev.pending - 1),
                approvedThisMonth: prev.approvedThisMonth + 1,
            }));
        } else if (action === 'rejected') {
            setStats((prev) => ({ ...prev, pending: Math.max(0, prev.pending - 1) }));
        }
        fetchStats();
    };

    // Check permissions
    if (!user || (user.role !== 'HR_MANAGER' && user.role !== 'ADMIN')) {
        return (
            <>
                {/* Denial by PANEL, not by redirect to /403 — the only screen
                    in the app that does this. Recorded as finding P4;
                    `term-noaccess` is what pins it. */}
                <div data-testid="term-noaccess" className="flex items-center justify-center min-h-[60vh]">
                    <div className="text-center">
                        <AlertCircle className="w-16 h-16 text-status-error mx-auto mb-4" />
                        <h2 className="text-2xl font-bold text-text-heading mb-2">
                            {t('noAccessTitle')}
                        </h2>
                        <p className="text-text-body">
                            {t('noAccessDesc')}
                        </p>
                    </div>
                </div>
            </>
        );
    }

    return (
        <>
            <div className="max-w-7xl mx-auto space-y-6">
                {/* Heading lives in TopHeader via usePageHeader — no action belongs here. */}

                {/* Stats Cards */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    {/* Pending Requests */}
                    <div className="bg-gradient-to-br from-status-warning-bg/40 to-status-warning-bg/90 border border-status-warning/20 rounded-[--radius-card] p-6 shadow-sm hover:shadow-lg transition-shadow">
                        <div className="flex items-center justify-between">
                            <div>
                                <p className="text-sm font-semibold text-status-warning mb-1">{t('statPendingApproval')}</p>
                                <p data-testid="term-stat-pending" className="text-3xl font-bold text-status-warning">
                                    {loading ? '-' : stats.pending}
                                </p>
                            </div>
                            <div className="w-12 h-12 bg-status-warning-bg rounded-[--radius-card] flex items-center justify-center">
                                <Clock className="text-status-warning" size={24} />
                            </div>
                        </div>
                    </div>

                    {/* Urgent Requests */}
                    <div className="bg-gradient-to-br from-status-error-bg/40 to-status-error-bg/90 border border-status-error/20 rounded-[--radius-card] p-6 shadow-sm hover:shadow-lg transition-shadow">
                        <div className="flex items-center justify-between">
                            <div>
                                <p className="text-sm font-semibold text-status-error mb-1">{t('statUrgent')}</p>
                                <p data-testid="term-stat-urgent" className="text-3xl font-bold text-status-error">
                                    {loading ? '-' : stats.urgent}
                                </p>
                            </div>
                            <div className="w-12 h-12 bg-status-error-bg rounded-[--radius-card] flex items-center justify-center">
                                <Flame className="text-status-error" size={24} />
                            </div>
                        </div>
                    </div>

                    {/* Approved This Month */}
                    <div className="bg-gradient-to-br from-status-success-bg/40 to-status-success-bg/90 border border-status-success/20 rounded-[--radius-card] p-6 shadow-sm hover:shadow-lg transition-shadow">
                        <div className="flex items-center justify-between">
                            <div>
                                <p className="text-sm font-semibold text-status-success mb-1">{t('statApprovedThisMonth')}</p>
                                <p data-testid="term-stat-approved" className="text-3xl font-bold text-status-success">
                                    {loading ? '-' : stats.approvedThisMonth}
                                </p>
                            </div>
                            <div className="w-12 h-12 bg-status-success-bg rounded-[--radius-card] flex items-center justify-center">
                                <CheckCircle className="text-status-success" size={24} />
                            </div>
                        </div>
                    </div>
                </div>

                {/* Filter Tabs - Simple & Practical */}
                <div className="flex items-center gap-3">
                    <span className="text-sm font-semibold text-text-muted">{t('showLabel')}</span>

                    <button
                        data-testid="term-filter-all"
                        onClick={() => setShowUrgentOnly(false)}
                        className={`px-5 py-2.5 rounded-[--radius-button] text-sm font-semibold transition-all cursor-pointer ${
                            !showUrgentOnly
                                ? 'bg-brand-primary text-text-on-brand shadow-lg'
                                : 'bg-surface-card border border-surface-border text-text-body hover:border-brand-primary-light/45'
                        }`}
                    >
                        <Clock className="inline-block me-2" size={16} />
                        {t('allCount', { count: stats.pending })}
                    </button>

                    <button
                        data-testid="term-urgent-filter"
                        onClick={() => setShowUrgentOnly(true)}
                        className={`px-5 py-2.5 rounded-[--radius-button] text-sm font-semibold transition-all cursor-pointer ${
                            showUrgentOnly
                                ? 'bg-status-error text-text-on-brand shadow-lg'
                                : 'bg-surface-card border border-surface-border text-text-body hover:border-status-error/30'
                        }`}
                    >
                        <Flame className="inline-block me-2" size={16} />
                        {t('urgentCount', { count: stats.urgent })}
                    </button>
                </div>

                {/* Tabs & Content */}
                <div className="bg-surface-card rounded-[--radius-card] shadow-sm border border-surface-border">
                    <div className="border-b border-surface-border">
                        <nav className="flex gap-6 px-6">
                            <button
                                data-testid="term-tab-pending"
                                onClick={() => setActiveTab('pending')}
                                className={`py-4 px-1 border-b-2 font-semibold text-sm transition-all flex items-center gap-2 cursor-pointer ${
                                    activeTab === 'pending'
                                        ? 'border-brand-primary text-brand-primary'
                                        : 'border-transparent text-text-muted hover:text-text-body'
                                }`}
                            >
                                <Clock size={18} />
                                {t('tabWaitingApproval')}
                                {stats.pending > 0 && (
                                    <span className="px-2 py-0.5 bg-status-info-bg text-status-info rounded-[--radius-badge] text-xs font-bold">
                                        {stats.pending}
                                    </span>
                                )}
                            </button>
                            <button
                                data-testid="term-tab-history"
                                onClick={() => setActiveTab('history')}
                                className={`py-4 px-1 border-b-2 font-semibold text-sm transition-all flex items-center gap-2 cursor-pointer ${
                                    activeTab === 'history'
                                        ? 'border-brand-primary text-brand-primary'
                                        : 'border-transparent text-text-muted hover:text-text-body'
                                }`}
                            >
                                <History size={18} />
                                {t('tabHistory')}
                            </button>
                        </nav>
                    </div>

                    {/* Content */}
                    <div className="p-6">
                        {activeTab === 'pending' && (
                            <TerminationApprovalPanel
                                userId={user!.id}
                                onUpdate={handleTerminationUpdate}
                                urgentOnly={showUrgentOnly}
                            />
                        )}

                        {activeTab === 'history' && <TerminationHistory />}
                    </div>
                </div>
            </div>
        </>
    );
}

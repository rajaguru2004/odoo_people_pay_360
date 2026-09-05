'use client';
import { getApiErrorMessage } from '@/lib/apiError';

import { useEffect, useState } from 'react';
import { getCompanyTz } from '@/utils/formatters';
import { Clock, CheckCircle2, XCircle, AlertCircle, FileText, User, Calendar } from 'lucide-react';
import { motion } from 'framer-motion';
import departmentChangeRequestService from '@/services/departmentChangeRequestService';
import { DepartmentChangeRequest, ChangeRequestStatus } from '@/types/department-change-request';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { usePageHeader } from '@/hooks/usePageHeader';

export default function ChangeRequestsPage() {
  const router = useRouter();
  const t = useTranslations('changeRequestsListPage');
  const tc = useTranslations('common');

  // The one heading for this route, rendered by TopHeader.
  usePageHeader(t('title'), t('subtitle'));

  const [requests, setRequests] = useState<DepartmentChangeRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ChangeRequestStatus | 'ALL'>('ALL');

  useEffect(() => {
    fetchRequests();
  }, [filter]);

  const fetchRequests = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await departmentChangeRequestService.getChangeRequests(
        filter !== 'ALL' ? { status: filter } : undefined
      );
      setRequests(response.data || []);
    } catch (error: any) {
      console.error('Error fetching change requests:', error);
      setRequests([]);
      setError(getApiErrorMessage(error, t('loadFailed')));
    } finally {
      setLoading(false);
    }
  };

  const getStatusBadge = (status: ChangeRequestStatus) => {
    const styles = {
      PENDING: 'bg-status-warning-bg text-status-warning border-status-warning/20',
      APPROVED: 'bg-status-success-bg text-status-success border-status-success/20',
      REJECTED: 'bg-status-error-bg text-status-error border-status-error/20',
      CANCELLED: 'bg-surface-page text-text-muted border-surface-border',
    };

    const icons = {
      PENDING: Clock,
      APPROVED: CheckCircle2,
      REJECTED: XCircle,
      CANCELLED: AlertCircle,
    };

    const labels = {
      PENDING: t('pending'),
      APPROVED: t('approved'),
      REJECTED: t('rejected'),
      CANCELLED: t('cancelled'),
    };

    const Icon = icons[status];

    return (
      <span data-testid="cr-status" className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-[--radius-badge] text-xs font-semibold border-2 ${styles[status]}`}>
        <Icon size={14} />
        {labels[status]}
      </span>
    );
  };

  const getRequestTypeLabel = (type: string) => {
    const labels = {
      CHANGE_MANAGER: t('typeChangeHead'),
      CHANGE_PARENT: t('typeChangeSuperior'),
      RESTRUCTURE: t('typeRestructuring'),
    };
    return labels[type as keyof typeof labels] || type;
  };

  const filteredRequests = requests;

  return (
    <div className="space-y-6">
      {/* Heading lives in TopHeader via usePageHeader — the gradient hero held
          nothing but the title, subtitle and a decorative icon, so it is gone. */}

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-surface-card rounded-[--radius-card] p-4 border border-surface-border shadow-sm">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-[--radius-card] bg-brand-primary-light/20 flex items-center justify-center">
              <FileText className="text-brand-primary" size={24} />
            </div>
            <div>
              <p className="text-sm text-text-muted">{t('all')}</p>
              <p data-testid="cr-stat-all" className="text-2xl font-bold text-text-heading">{requests?.length || 0}</p>
            </div>
          </div>
        </div>
        <div className="bg-surface-card rounded-[--radius-card] p-4 border border-surface-border shadow-sm">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-[--radius-card] bg-status-warning-bg flex items-center justify-center">
              <Clock className="text-status-warning" size={24} />
            </div>
            <div>
              <p className="text-sm text-text-muted">{t('pending')}</p>
              <p data-testid="cr-stat-pending" className="text-2xl font-bold text-status-warning">
                {requests?.filter(r => r.status === 'PENDING').length || 0}
              </p>
            </div>
          </div>
        </div>
        <div className="bg-surface-card rounded-[--radius-card] p-4 border border-surface-border shadow-sm">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-[--radius-card] bg-status-success-bg flex items-center justify-center">
              <CheckCircle2 className="text-status-success" size={24} />
            </div>
            <div>
              <p className="text-sm text-text-muted">{t('approved')}</p>
              <p data-testid="cr-stat-approved" className="text-2xl font-bold text-status-success">
                {requests?.filter(r => r.status === 'APPROVED').length || 0}
              </p>
            </div>
          </div>
        </div>
        <div className="bg-surface-card rounded-[--radius-card] p-4 border border-surface-border shadow-sm">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-[--radius-card] bg-status-error-bg flex items-center justify-center">
              <XCircle className="text-status-error" size={24} />
            </div>
            <div>
              <p className="text-sm text-text-muted">{t('rejected')}</p>
              <p data-testid="cr-stat-rejected" className="text-2xl font-bold text-status-error">
                {requests?.filter(r => r.status === 'REJECTED').length || 0}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-surface-card rounded-[--radius-card] border border-surface-border p-6 shadow-sm">
        <div className="flex items-center gap-3">
          <span className="text-sm font-bold text-text-heading">{t('filterByStatus')}</span>
          {(['ALL', 'PENDING', 'APPROVED', 'REJECTED'] as const).map((status) => (
            <button
              key={status}
              data-testid={`cr-filter-${status}`}
              onClick={() => setFilter(status)}
              className={`px-6 py-2.5 rounded-[--radius-button] text-sm font-semibold transition-all cursor-pointer ${
                filter === status
                  ? 'bg-gradient-to-r from-brand-primary to-brand-primary-dark text-text-on-brand shadow-lg scale-105'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200 hover:scale-105' /* neutral */
              }`}
            >
              {status === 'ALL' ? t('all') : status === 'PENDING' ? t('pending') : status === 'APPROVED' ? t('approved') : t('rejected')}
            </button>
          ))}
        </div>
      </div>

      {/* Requests List */}
      {loading ? (
        <div className="grid gap-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="bg-surface-card rounded-[--radius-card] border border-surface-border p-6 animate-pulse">
              <div className="h-6 bg-slate-200 rounded w-1/3 mb-4"></div> {/* neutral */}
              <div className="h-4 bg-slate-100 rounded w-2/3"></div> {/* neutral */}
            </div>
          ))}
        </div>
      ) : error ? (
        <div data-testid="cr-error" className="bg-status-error-bg rounded-[--radius-card] border border-status-error/20 p-12 text-center">
          <AlertCircle className="mx-auto text-status-error mb-4" size={48} />
          <p className="text-status-error font-medium mb-2">{error}</p>
          <button
            onClick={fetchRequests}
            className="mt-4 px-4 py-2 bg-status-error text-white rounded-[--radius-button] hover:bg-status-error/90 transition-colors cursor-pointer"
          >
            {tc('retry')}
          </button>
        </div>
      ) : filteredRequests.length === 0 ? (
        <div data-testid="cr-empty" className="bg-surface-page rounded-[--radius-card] border-2 border-dashed border-surface-border p-16 text-center">
          <div className="w-24 h-24 mx-auto mb-6 rounded-full bg-surface-card shadow-lg flex items-center justify-center">
            <FileText className="text-text-muted" size={48} />
          </div>
          <h3 className="text-xl font-bold text-text-heading mb-2">{t('noRequests')}</h3>
          <p className="text-text-muted">{t('noRequestsDesc')}</p>
        </div>
      ) : (
        <div className="grid gap-6">
          {filteredRequests.map((request, index) => (
            <motion.div
              key={request.id}
              data-testid={`cr-card-${request.id}`}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.05 }}
              className="bg-surface-card rounded-[--radius-card] border-2 border-surface-border p-6 hover:border-brand-primary hover:shadow-2xl transition-all cursor-pointer group"
              onClick={() => router.push(`/dashboard/departments/change-requests/${request.id}`)}
            >
              <div className="flex items-start justify-between mb-6">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-12 h-12 rounded-[--radius-card] bg-gradient-to-br from-brand-primary to-brand-primary-dark flex items-center justify-center">
                      <FileText className="text-text-on-brand" size={24} />
                    </div>
                    <div>
                      <h3 className="text-xl font-bold text-text-heading group-hover:text-brand-primary transition-colors">
                        {request.department?.name || tc('notAvailable')}
                      </h3>
                      <p className="text-sm text-text-muted font-medium">
                        {getRequestTypeLabel(request.requestType)}
                      </p>
                    </div>
                  </div>
                </div>
                {getStatusBadge(request.status)}
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mb-6">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-[--radius-card] bg-brand-primary-light/20 flex items-center justify-center flex-shrink-0">
                    <User size={18} className="text-brand-primary" />
                  </div>
                  <div>
                    <p className="text-xs text-text-muted font-semibold mb-1">{t('requester')}</p>
                    <p className="text-sm font-bold text-text-heading">
                      {request.requester?.employee?.fullName || tc('notAvailable')}
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-[--radius-card] bg-brand-accent/10 flex items-center justify-center flex-shrink-0">
                    <Calendar size={18} className="text-brand-accent" />
                  </div>
                  <div>
                    <p className="text-xs text-text-muted font-semibold mb-1">{t('effectiveDate')}</p>
                    <p className="text-sm font-bold text-text-heading">
                      {new Date(request.effectiveDate).toLocaleDateString('en-IN', { timeZone: getCompanyTz() })}
                    </p>
                  </div>
                </div>

                {request.requestType === 'CHANGE_MANAGER' && (
                  <>
                    <div>
                      <p className="text-xs text-text-muted font-semibold mb-1">{t('formerDeptHead')}</p>
                      <p className="text-sm font-bold text-text-heading">
                        {request.oldManager?.fullName || tc('notYet')}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-text-muted font-semibold mb-1">{t('newDeptHead')}</p>
                      <p className="text-sm font-bold text-brand-primary">
                        {request.newManager?.fullName || tc('notAvailable')}
                      </p>
                    </div>
                  </>
                )}
              </div>

              <div className="bg-surface-page rounded-[--radius-card] p-4 border border-surface-border">
                <p className="text-xs text-text-muted font-bold mb-2">{t('reasonLabel')}</p>
                <p className="text-sm text-text-body leading-relaxed">{request.reason}</p>
              </div>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}

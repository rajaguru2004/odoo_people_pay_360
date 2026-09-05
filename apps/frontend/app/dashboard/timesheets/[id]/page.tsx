'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { CheckCircle2, XCircle, Send, Loader2 } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import PageActionRow from '@/components/common/PageActionRow';
import { usePermission } from '@/hooks/usePermission';
import { usePageHeader } from '@/hooks/usePageHeader';
import { formatWallClockDate, formatDateTime } from '@/utils/formatters';
import { useAuthStore } from '@/store/authStore';
import timesheetService, { Timesheet } from '@/services/timesheetService';
import { TimesheetStatusBadge } from '@/components/timesheets/TimesheetStatusBadge';

export default function TimesheetDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;
  const { user } = useAuthStore();
  const { can } = usePermission();

  // The one heading for this route, rendered by TopHeader. Declared before the
  // loading/not-found early returns so the hook order never changes.
  usePageHeader('Timesheet Details');

  const [ts, setTs] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);

  const fetchTs = useCallback(async () => {
    try {
      const res = await timesheetService.getById(id) as any;
      setTs(res.data);
    } catch { router.push('/dashboard/timesheets'); }
    finally { setLoading(false); }
  }, [id, router]);

  useEffect(() => { fetchTs(); }, [fetchTs]);

  const handleSubmit = async () => {
    setActionLoading(true);
    try { await timesheetService.submit(id); await fetchTs(); }
    finally { setActionLoading(false); }
  };

  const handleApprove = async () => {
    setActionLoading(true);
    try { await timesheetService.approve(id); await fetchTs(); }
    finally { setActionLoading(false); }
  };

  const handleReject = async () => {
    const reason = prompt('Rejection reason:');
    if (reason === null) return;
    setActionLoading(true);
    try { await timesheetService.reject(id, reason); await fetchTs(); }
    finally { setActionLoading(false); }
  };

  const handleDelete = async () => {
    if (!confirm('Delete this timesheet?')) return;
    await timesheetService.delete(id);
    router.push('/dashboard/timesheets');
  };

  if (loading) return (
    <div className="flex items-center justify-center py-20">
      <div className="h-10 w-10 rounded-full border-2 border-brand-primary border-t-transparent animate-spin" />
    </div>
  );
  if (!ts) return null;

  const isOwner = ts.employeeId === user?.employeeId;
  const isManager = ['ADMIN', 'HR_MANAGER', 'MANAGER'].includes(user?.role || '');

  return (
    <ProtectedRoute requiredPermission="VIEW_TIMESHEETS">
      <div className="space-y-6">
        <div className="max-w-2xl mx-auto">
          {/* Back button only — the title lives in the sticky TopHeader,
              declared via usePageHeader above. */}
          <div className="mb-6">
            <PageActionRow onBack={() => router.back()} />
          </div>

          <motion.div
            initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
            className="bg-surface-card border border-surface-border rounded-[--radius-card] p-8 space-y-6 shadow-sm"
          >
            <div className="flex items-center justify-between">
              <TimesheetStatusBadge status={ts.status} />
              <span className="text-2xl font-bold font-mono text-status-success">{ts.hoursWorked}h</span>
            </div>

            <div className="grid grid-cols-2 gap-4 text-sm">
              {[
                { label: 'Employee', value: ts.employee?.fullName },
                { label: 'Department', value: ts.employee?.department?.name || '—' },
                { label: 'Work Date', value: formatWallClockDate(ts.workDate) },
                { label: 'Submitted', value: ts.submittedAt ? formatDateTime(ts.submittedAt) : '—' },
                { label: 'Approved By', value: ts.approver?.employee?.fullName || '—' },
              ].map(({ label, value }) => (
                <div key={label}>
                  <p className="text-text-muted font-semibold">{label}</p>
                  <p className="text-text-heading font-bold mt-0.5">{value}</p>
                </div>
              ))}
            </div>

            {ts.description && (
              <div className="rounded-[--radius-input] bg-surface-page border border-surface-border p-4">
                <p className="text-xs text-text-muted mb-1 font-semibold">Description</p>
                <p className="text-sm text-text-body">{ts.description}</p>
              </div>
            )}

            {ts.rejectionReason && (
              <div className="rounded-[--radius-input] bg-status-error-bg/40 border border-status-error/20 p-4">
                <p className="text-xs text-status-error mb-1 font-semibold">Rejection Reason</p>
                <p className="text-sm text-status-error">{ts.rejectionReason}</p>
              </div>
            )}

            {/* Actions */}
            <div className="flex flex-wrap gap-3 pt-4 border-t border-surface-border">
              {isOwner && ts.status === 'DRAFT' && (
                <>
                  <motion.button
                    whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
                    onClick={handleSubmit} disabled={actionLoading}
                    className="flex items-center gap-2 rounded-[--radius-button] bg-brand-primary hover:bg-brand-primary-dark px-5 py-2.5 text-sm font-semibold text-text-on-brand transition-all disabled:opacity-50 shadow-md cursor-pointer"
                  >
                    {actionLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    Submit for Approval
                  </motion.button>
                  <button onClick={handleDelete} className="rounded-[--radius-button] border border-status-error/30 px-5 py-2.5 text-sm text-status-error hover:bg-status-error-bg/40 transition-all font-semibold cursor-pointer">
                    Delete
                  </button>
                </>
              )}

              {isManager && ts.status === 'SUBMITTED' && (
                <>
                  <motion.button
                    whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
                    onClick={handleApprove} disabled={actionLoading}
                    className="flex items-center gap-2 rounded-[--radius-button] bg-status-success hover:bg-status-success/90 px-5 py-2.5 text-sm font-semibold text-white transition-all disabled:opacity-50 shadow-md cursor-pointer"
                  >
                    <CheckCircle2 className="h-4 w-4" />
                    Approve
                  </motion.button>
                  <motion.button
                    whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
                    onClick={handleReject} disabled={actionLoading}
                    className="flex items-center gap-2 rounded-[--radius-button] bg-status-error hover:bg-status-error/90 px-5 py-2.5 text-sm font-semibold text-white transition-all disabled:opacity-50 shadow-md cursor-pointer"
                  >
                    <XCircle className="h-4 w-4" />
                    Reject
                  </motion.button>
                </>
              )}
            </div>
          </motion.div>
        </div>
      </div>
    </ProtectedRoute>
  );
}

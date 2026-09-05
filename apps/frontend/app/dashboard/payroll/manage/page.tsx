'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  Plus,
  Eye,
  Lock,
  Trash2,
  Calendar,
  Clock,
  Users,
  Search,
  Check,
  Info,
  Layers,
  UserPlus,
  SendHorizontal
} from 'lucide-react';
import { CurrencyIcon } from '@/components/common/CurrencyIcon';
import payrollService from '@/services/payrollService';
import payrollBatchService from '@/services/payrollBatchService';
import employeeService from '@/services/employeeService';
import departmentService from '@/services/departmentService';
import { Payroll } from '@/types/payroll';
import { PayrollBatch } from '@/types/payrollBatch';
import { Employee } from '@/types/employee';
import { Department } from '@/types/department';
import { formatCurrency, getCompanyTz } from '@/utils/formatters';
import { toast } from '@/lib/toast';
import { useConfirm } from '@/hooks/useConfirm';
import { usePageHeader } from '@/hooks/usePageHeader';
import PageActionRow from '@/components/common/PageActionRow';
import ProtectedRoute from '@/components/auth/ProtectedRoute';

function ManagePayrollPageContent() {
  const router = useRouter();
  const t = useTranslations('payrollManagePage');
  const tc = useTranslations('common');
  const { confirm, ConfirmDialog, closeModal, setLoading: setConfirmLoading } = useConfirm();

  // The one heading for this route, rendered by TopHeader.
  usePageHeader(t('title'), t('subtitle'));
  
  // Data State
  const [payrolls, setPayrolls] = useState<Payroll[]>([]);
  const [batches, setBatches] = useState<PayrollBatch[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  
  // UI State
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  
  // Form State
  const [selectedMonth, setSelectedMonth] = useState(new Date().getMonth() + 1);
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  const [generationType, setGenerationType] = useState<'ALL' | 'BATCH' | 'CUSTOM'>('ALL');
  const [selectedBatchId, setSelectedBatchId] = useState('');
  const [selectedCustomEmployeeIds, setSelectedCustomEmployeeIds] = useState<string[]>([]);
  
  // Modal Search/Filter state
  const [modalSearchQuery, setModalSearchQuery] = useState('');
  const [modalDeptFilter, setModalDeptFilter] = useState('');

  // Read URL query params
  const [queryBatchId, setQueryBatchId] = useState<string | null>(null);

  useEffect(() => {
    fetchPayrolls();
    loadModalData();

    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const bId = params.get('batchId');
      if (bId) {
        setQueryBatchId(bId);
      }
    }
  }, []);

  useEffect(() => {
    if (queryBatchId && batches.length > 0) {
      setGenerationType('BATCH');
      setSelectedBatchId(queryBatchId);
      setShowCreateModal(true);
    }
  }, [queryBatchId, batches]);

  const fetchPayrolls = async () => {
    try {
      setLoading(true);
      const response = await payrollService.getAll();
      setPayrolls(response.data);
    } catch (error) {
      console.error('Failed to fetch payrolls:', error);
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  const loadModalData = async () => {
    try {
      const [batchesRes, employeesRes, deptsRes] = await Promise.all([
        payrollBatchService.getAll(),
        employeeService.getAll({ status: 'ACTIVE', limit: 500 }),
        departmentService.getAll()
      ]);
      setBatches(batchesRes.data || []);
      setEmployees(employeesRes.data || []);
      setDepartments(deptsRes.data || []);
    } catch (error) {
      console.error('Failed to load metadata:', error);
    }
  };

  const handleOpenCreateModal = () => {
    setGenerationType('ALL');
    setSelectedBatchId('');
    setSelectedCustomEmployeeIds([]);
    setModalSearchQuery('');
    setModalDeptFilter('');
    setShowCreateModal(true);
  };

  const handleCreatePayroll = async () => {
    if (generationType === 'BATCH' && !selectedBatchId) {
      toast.error(t('selectBatchWarning'));
      return;
    }
    if (generationType === 'CUSTOM' && selectedCustomEmployeeIds.length === 0) {
      toast.error(t('selectAtLeastOneWarning'));
      return;
    }

    // Close the create modal first
    setShowCreateModal(false);

    let scopeLabel = t('scopeAllEmployeesText');
    if (generationType === 'BATCH') {
      const batch = batches.find(b => b.id === selectedBatchId);
      scopeLabel = t('scopeBatchText', { name: batch?.name || t('scopeUnknownBatch') });
    } else if (generationType === 'CUSTOM') {
      scopeLabel = t('scopeCustomText', { count: selectedCustomEmployeeIds.length });
    }

    const confirmed = await confirm({
      title: t('createConfirmTitle'),
      message: t('createConfirmMessage', { month: selectedMonth, year: selectedYear, scope: scopeLabel }),
      confirmText: t('createPayrollBtn'),
      type: 'info'
    });

    if (!confirmed) {
      // If cancelled, reopen the create modal
      setShowCreateModal(true);
      return;
    }

    try {
      setCreating(true);
      setConfirmLoading(true);
      toast.info(t('generatingToast', { scope: scopeLabel }));

      const payload: any = {
        month: selectedMonth,
        year: selectedYear,
      };

      if (generationType === 'BATCH') {
        payload.batchId = selectedBatchId;
      } else if (generationType === 'CUSTOM') {
        payload.employeeIds = selectedCustomEmployeeIds;
      }

      const response = await payrollService.create(payload);

      closeModal();
      toast.success(
        t('createSuccessToast', {
          month: selectedMonth,
          year: selectedYear,
          count: response.data?.items?.length || response.data?._count?.items || 0
        })
      );
      fetchPayrolls();
    } catch (error: any) {
      console.error('Failed to create payroll:', error);
      closeModal();

      let errorMessage = t('createFailedFallback');
      if (error?.message) {
        errorMessage = error.message;
      } else if (error?.statusCode === 408 || error?.message?.includes('timeout')) {
        errorMessage = t('createTimeoutMessage');
      }

      toast.error(errorMessage);
      setShowCreateModal(true);
    } finally {
      setCreating(false);
    }
  };

  // DRAFT -> submit -> PENDING_APPROVAL -> (approvals screen) -> APPROVED -> lock.
  // This row used to offer a single padlock on DRAFT that jumped straight to
  // LOCKED, skipping approval entirely.
  const handleSubmitForApproval = async (
    id: string,
    month: number,
    year: number,
  ) => {
    const confirmed = await confirm({
      title: t('submitConfirmTitle'),
      message: t('submitConfirmMessage', { month, year }),
      confirmText: t('submitConfirmText'),
      type: 'warning',
    });

    if (!confirmed) return;

    try {
      setConfirmLoading(true);
      await payrollService.submit(id);
      closeModal();
      toast.success(t('submitSuccessToast'));
      fetchPayrolls();
    } catch (error: any) {
      console.error('Failed to submit payroll for approval:', error);
      closeModal();
      toast.error(error?.message || t('submitFailedFallback'));
    }
  };

  const handleLock = async (id: string, month: number, year: number) => {
    const confirmed = await confirm({
      title: t('lockConfirmTitle'),
      message: t('lockConfirmMessage', { month, year }),
      confirmText: t('lockConfirmText'),
      type: 'warning',
    });

    if (!confirmed) return;

    try {
      setConfirmLoading(true);
      await payrollService.lock(id);
      closeModal();
      toast.success(t('lockSuccessToast'));
      fetchPayrolls();
    } catch (error: any) {
      console.error('Failed to lock payroll:', error);
      closeModal();
      toast.error(error?.message || t('lockFailedFallback'));
    }
  };

  const handleDeletePayroll = async (id: string, month: number, year: number) => {
    const confirmed = await confirm({
      title: t('deleteConfirmTitle'),
      message: t('deleteConfirmMessage', { month, year }),
      confirmText: t('deleteConfirmText'),
      type: 'danger'
    });

    if (!confirmed) return;

    try {
      setConfirmLoading(true);
      await payrollService.delete(id);
      closeModal();
      toast.success(t('deleteSuccessToast', { month, year }));
      fetchPayrolls();
    } catch (error: any) {
      console.error('Failed to delete payroll:', error);
      closeModal();
      const errorMessage = error?.message || t('deleteFailedFallback');
      toast.error(errorMessage);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'DRAFT':
        return (
          <span className="px-3 py-1 bg-status-warning-bg text-status-warning rounded-full text-xs font-semibold">
            {tc('draft')}
          </span>
        );
      case 'PENDING_APPROVAL':
        return (
          <span className="px-3 py-1 bg-status-info-bg text-status-info rounded-full text-xs font-semibold">
            {tc('pending')}
          </span>
        );
      case 'APPROVED':
        return (
          <span className="px-3 py-1 bg-status-success-bg text-status-success rounded-full text-xs font-semibold">
            {tc('approved')}
          </span>
        );
      case 'REJECTED':
        return (
          <span className="px-3 py-1 bg-status-error-bg text-status-error rounded-full text-xs font-semibold">
            {tc('rejected')}
          </span>
        );
      case 'LOCKED':
        return (
          <span className="px-3 py-1 bg-slate-100 text-slate-700 rounded-full text-xs font-semibold">
            {tc('locked')}
          </span>
        );
      default:
        return (
          <span className="px-3 py-1 bg-gray-100 text-gray-700 rounded-full text-xs font-semibold">
            {status}
          </span>
        );
    }
  };

  const stats = {
    total: payrolls.length,
    draft: payrolls.filter(p => p.status === 'DRAFT').length,
    finalized: payrolls.filter(p => p.status === 'LOCKED').length,
    totalAmount: payrolls.reduce((sum, p) => sum + Number(p.totalAmount), 0),
  };

  // Custom picker filters
  const filteredEmployees = employees.filter(emp => {
    const matchesSearch = emp.fullName.toLowerCase().includes(modalSearchQuery.toLowerCase()) ||
      emp.employeeCode.toLowerCase().includes(modalSearchQuery.toLowerCase());
    const matchesDept = !modalDeptFilter || emp.departmentId === modalDeptFilter;
    return matchesSearch && matchesDept;
  });

  const toggleEmployeeSelection = (id: string) => {
    setSelectedCustomEmployeeIds(prev =>
      prev.includes(id) ? prev.filter(empId => empId !== id) : [...prev, id]
    );
  };

  return (
    <>
      <ConfirmDialog />
      <div className="space-y-6">
        {/* Breadcrumb + primary action. The title/description live in the sticky
            TopHeader (declared via usePageHeader above) — repeating them here is
            what made the page render its heading twice. */}
        <PageActionRow
          action={
            <button
              onClick={handleOpenCreateModal}
              className="flex items-center gap-2 px-5 py-2.5 bg-brand-primary text-white rounded-xl hover:bg-brand-primary-dark transition-colors font-semibold shadow-sm"
            >
              <Plus size={18} />
              {t('createPayrollBtn')}
            </button>
          }
        />

        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          <div className="surface-panel p-6">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 bg-brand-primary-light/20 rounded-lg flex items-center justify-center">
                <Calendar className="text-brand-primary" size={20} />
              </div>
              <p className="text-sm text-slate-600">{t('statTotalPayroll')}</p>
            </div>
            <p className="text-3xl font-bold text-slate-900">{stats.total}</p>
            <p className="text-xs text-slate-400 mt-1">{t('statTotalPayrollCaption')}</p>
          </div>

          <div className="surface-panel p-6">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 bg-status-warning-bg rounded-lg flex items-center justify-center">
                <Clock className="text-status-warning" size={20} />
              </div>
              <p className="text-sm text-slate-600">{tc('draft')}</p>
            </div>
            <p className="text-3xl font-bold text-status-warning">{stats.draft}</p>
            <p className="text-xs text-slate-400 mt-1">{t('draftCaption')}</p>
          </div>

          <div className="surface-panel p-6">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 bg-status-success-bg rounded-lg flex items-center justify-center">
                <Lock className="text-status-success" size={20} />
              </div>
              <p className="text-sm text-slate-600">{t('statFinalized')}</p>
            </div>
            <p className="text-3xl font-bold text-status-success">{stats.finalized}</p>
            <p className="text-xs text-slate-400 mt-1">{t('statFinalizedCaption')}</p>
          </div>

          <div className="bg-status-error-bg/30 rounded-xl p-6 border border-status-error/20 shadow-sm">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 bg-white rounded-lg flex items-center justify-center">
                <CurrencyIcon size={20} className="text-status-error" />
              </div>
              <p className="text-sm text-status-error/80">{t('statTotalExpenditure')}</p>
            </div>
            <p className="text-2xl font-bold text-status-error">{formatCurrency(stats.totalAmount)}</p>
            <p className="text-xs text-status-error/60 mt-1">{t('statTotalExpenditureCaption')}</p>
          </div>
        </div>

        {/* Payroll List */}
        <div className="surface-panel overflow-hidden">
          <div className="px-6 py-5 border-b border-slate-200">
            <h2 className="text-lg font-bold text-slate-900">{t('sectionTitle')}</h2>
            <p className="text-sm text-slate-500 mt-0.5">{t('sectionSubtitle')}</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-6 py-4 text-start text-sm font-semibold text-slate-700">{t('colPayrollPeriod')}</th>
                  <th className="px-6 py-4 text-start text-sm font-semibold text-slate-700">{t('colScope')}</th>
                  <th className="px-6 py-4 text-center text-sm font-semibold text-slate-700">{t('colNumberOfEmployees')}</th>
                  <th className="px-6 py-4 text-end text-sm font-semibold text-slate-700">{t('colTotalExpenditure')}</th>
                  <th className="px-6 py-4 text-center text-sm font-semibold text-slate-700">{tc('status')}</th>
                  <th className="px-6 py-4 text-center text-sm font-semibold text-slate-700">{t('colCreationDate')}</th>
                  <th className="px-6 py-4 text-center text-sm font-semibold text-slate-700">{tc('actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {loading ? (
                  <tr>
                    <td colSpan={7} className="px-6 py-12 text-center">
                      <div className="flex items-center justify-center">
                        <div className="w-8 h-8 border-4 border-brand-primary border-t-transparent rounded-full animate-spin"></div>
                      </div>
                    </td>
                  </tr>
                ) : payrolls.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-6 py-12 text-center text-slate-500">
                      {t('emptyNoRecords')}
                    </td>
                  </tr>
                ) : (
                  payrolls.map((payroll) => (
                    <tr key={payroll.id} className="hover:bg-slate-50 transition-colors">
                       <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          <Calendar className="text-brand-primary" size={18} />
                          <span className="font-semibold text-text-heading">
                            {t('rowMonthYear', { month: payroll.month, year: payroll.year })}
                          </span>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        {payroll.batch?.name ? (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-status-info-bg text-status-info border border-status-info/20">
                            <Layers size={11} />
                            {payroll.batch.name}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-50 text-slate-600 border border-slate-100">
                            <Users size={11} />
                            {t('allEmployeesBadge')}
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-center">
                        <span className="font-semibold text-slate-700">
                          {t('peopleCountSuffix', { count: payroll._count?.items || 0 })}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-end">
                        <span className="font-bold text-status-success">
                          {formatCurrency(Number(payroll.totalAmount))}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-center">
                        {getStatusBadge(payroll.status)}
                      </td>
                      <td className="px-6 py-4 text-center text-sm text-slate-600">
                        {new Date(payroll.createdAt).toLocaleDateString('en-IN', { timeZone: getCompanyTz() })}
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center justify-center gap-2">
                          <button
                            onClick={() => router.push(`/dashboard/payroll/${payroll.id}`)}
                            className="p-2 hover:bg-brand-primary-light/20 rounded-lg text-brand-primary transition-colors"
                            title={t('viewDetailsTooltip')}
                          >
                            <Eye size={18} />
                          </button>
                          {(payroll.status === 'DRAFT' ||
                            payroll.status === 'REJECTED') && (
                            <button
                              data-testid="payroll-submit-approval"
                              onClick={() => handleSubmitForApproval(payroll.id, payroll.month, payroll.year)}
                              className="p-2 hover:bg-brand-primary-light/20 rounded-lg text-brand-primary transition-colors"
                              title={t('submitTooltip')}
                            >
                              <SendHorizontal size={18} />
                            </button>
                          )}
                          {payroll.status === 'APPROVED' && (
                            <button
                              data-testid="payroll-lock"
                              onClick={() => handleLock(payroll.id, payroll.month, payroll.year)}
                              className="p-2 hover:bg-status-success-bg/60 rounded-lg text-status-success transition-colors"
                              title={t('lockTooltip')}
                            >
                              <Lock size={18} />
                            </button>
                          )}
                          {payroll.status !== 'LOCKED' && (
                            <button
                              onClick={() => handleDeletePayroll(payroll.id, payroll.month, payroll.year)}
                              className="p-2 hover:bg-status-error-bg/60 rounded-lg text-status-error transition-colors"
                              title={t('deletePayrollTooltip')}
                            >
                              <Trash2 size={18} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Create Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 overflow-y-auto p-4">
          <div className="bg-white rounded-2xl p-8 max-w-xl w-full mx-auto my-8 shadow-2xl relative">
            <h3 className="text-xl font-bold text-primary mb-2">{t('modalTitleCreate')}</h3>
            <p className="text-slate-500 text-sm mb-6">{t('modalSubtitle')}</p>

            <div className="space-y-6">
              {/* Month / Year selection */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-2">
                    {t('monthLabel')}
                  </label>
                  <select
                    value={selectedMonth}
                    onChange={(e) => setSelectedMonth(Number(e.target.value))}
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary/20"
                  >
                    {Array.from({ length: 12 }, (_, i) => i + 1).map((month) => (
                      <option key={month} value={month}>
                        {t('monthOption', { n: month })}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-2">
                    {t('yearLabel')}
                  </label>
                  <select
                    value={selectedYear}
                    onChange={(e) => setSelectedYear(Number(e.target.value))}
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary/20"
                  >
                    {[2024, 2025, 2026, 2027].map((year) => (
                      <option key={year} value={year}>
                        {year}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Generation Scope selection */}
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-3">
                  {t('selectScopeLabel')}
                </label>
                
                <div className="grid grid-cols-3 gap-3">
                  <button
                    type="button"
                    onClick={() => setGenerationType('ALL')}
                    className={`flex flex-col items-center justify-center p-4 rounded-xl border text-center transition-all ${
                      generationType === 'ALL'
                        ? 'border-brand-primary bg-brand-primary-light/10 text-brand-primary ring-2 ring-brand-primary/10'
                        : 'border-slate-200 hover:bg-slate-50 text-slate-600'
                    }`}
                  >
                    <Users size={20} className="mb-2" />
                    <span className="text-xs font-bold">{t('allEmployeesBadge')}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setGenerationType('BATCH')}
                    className={`flex flex-col items-center justify-center p-4 rounded-xl border text-center transition-all ${
                      generationType === 'BATCH'
                        ? 'border-brand-primary bg-brand-primary-light/10 text-brand-primary ring-2 ring-brand-primary/10'
                        : 'border-slate-200 hover:bg-slate-50 text-slate-600'
                    }`}
                  >
                    <Layers size={20} className="mb-2" />
                    <span className="text-xs font-bold">{t('scopeSavedBatch')}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setGenerationType('CUSTOM')}
                    className={`flex flex-col items-center justify-center p-4 rounded-xl border text-center transition-all ${
                      generationType === 'CUSTOM'
                        ? 'border-brand-primary bg-brand-primary-light/10 text-brand-primary ring-2 ring-brand-primary/10'
                        : 'border-slate-200 hover:bg-slate-50 text-slate-600'
                    }`}
                  >
                    <UserPlus size={20} className="mb-2" />
                    <span className="text-xs font-bold">{t('scopeCustomSelect')}</span>
                  </button>
                </div>
              </div>

              {/* Conditional Panels */}
              {generationType === 'BATCH' && (
                <div className="bg-slate-50 border border-slate-100 rounded-xl p-4 space-y-3">
                  <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider">
                    {t('selectSavedBatchLabel')}
                  </label>
                  {batches.length === 0 ? (
                    <div className="text-sm text-slate-500">
                      {t('noBatchesDefined')}{' '}
                      <button
                        onClick={() => router.push('/dashboard/payroll/batches')}
                        className="text-brand-primary font-semibold underline"
                      >
                        {t('createBatchFirstLink')}
                      </button>
                    </div>
                  ) : (
                    <select
                      value={selectedBatchId}
                      onChange={(e) => setSelectedBatchId(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary/20 bg-white"
                    >
                      <option value="">{t('chooseBatchPlaceholder')}</option>
                      {batches.map(b => (
                        <option key={b.id} value={b.id}>
                          {t('batchOptionLabel', { name: b.name, count: b._count?.members ?? 0 })}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              )}

              {generationType === 'CUSTOM' && (
                <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider">
                      {t('selectEmployeesCountLabel', { count: selectedCustomEmployeeIds.length })}
                    </label>

                    <button
                      type="button"
                      onClick={() => setSelectedCustomEmployeeIds(employees.map(e => e.id))}
                      className="text-[10px] text-brand-primary font-bold hover:underline"
                    >
                      {t('selectAllActiveBtn')}
                    </button>
                  </div>

                  {/* Picker search */}
                  <div className="grid grid-cols-2 gap-2">
                    <div className="relative">
                      <Search className="absolute start-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
                      <input
                        type="text"
                        value={modalSearchQuery}
                        onChange={(e) => setModalSearchQuery(e.target.value)}
                        placeholder={t('searchNamePlaceholder')}
                        className="w-full ps-8 pe-2 py-1.5 border border-slate-200 rounded-lg text-xs"
                      />
                    </div>
                    <select
                      value={modalDeptFilter}
                      onChange={(e) => setModalDeptFilter(e.target.value)}
                      className="w-full px-2 py-1.5 border border-slate-200 rounded-lg text-xs bg-white"
                    >
                      <option value="">{t('allDeptsOption')}</option>
                      {departments.map(d => (
                        <option key={d.id} value={d.id}>{d.name}</option>
                      ))}
                    </select>
                  </div>

                  <div className="border border-slate-200 rounded-lg max-h-[160px] overflow-y-auto divide-y divide-slate-100 bg-white custom-scrollbar">
                    {filteredEmployees.length === 0 ? (
                      <div className="p-4 text-center text-slate-400 text-xs">{t('noMatchingEmployees')}</div>
                    ) : (
                      filteredEmployees.map(emp => {
                        const isSelected = selectedCustomEmployeeIds.includes(emp.id);
                        return (
                          <div
                            key={emp.id}
                            onClick={() => toggleEmployeeSelection(emp.id)}
                            className={`flex items-center justify-between p-2.5 cursor-pointer text-xs transition-colors ${
                              isSelected ? 'bg-brand-primary-light/10' : 'hover:bg-slate-50'
                            }`}
                          >
                            <div className="min-w-0">
                              <p className="font-bold text-slate-800 truncate">{emp.fullName}</p>
                              <p className="text-[10px] text-slate-400 truncate">
                                {emp.employeeCode} • {emp.position}
                              </p>
                            </div>
                            <div
                              className={`w-4 h-4 rounded-md border flex items-center justify-center shrink-0 ${
                                isSelected ? 'bg-brand-primary border-brand-primary text-white' : 'border-slate-300'
                              }`}
                            >
                              {isSelected && <Check size={10} strokeWidth={3} />}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 mt-6 flex gap-3 items-start">
              <Info className="text-yellow-700 shrink-0 mt-0.5" size={16} />
              <div className="text-xs text-yellow-800">
                <strong>{t('noteLabel')}</strong> {t('payrollRunInfoDesc')}
              </div>
            </div>

            <div className="flex gap-4 mt-6">
              <button
                data-testid="payroll-create-confirm"
                onClick={handleCreatePayroll}
                disabled={creating}
                className="flex-1 px-6 py-3 bg-brand-primary text-white font-semibold rounded-xl hover:bg-brand-primary-dark transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {creating && <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>}
                {t('createPayrollBtn')}
              </button>
              <button
                onClick={() => setShowCreateModal(false)}
                className="px-6 py-3 border border-slate-200 text-slate-700 font-semibold rounded-xl hover:bg-slate-50 transition-colors"
              >
                {tc('cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * MANAGE_PAYROLL, matching the server: `GET /payrolls` and every write door on it
 * admit ADMIN and HR_MANAGER only. Without this the page rendered its chrome,
 * its stat cards and its action buttons for a manager or an employee and then
 * fired requests the API refused — a screen that looks usable and is not.
 */
export default function ManagePayrollPage() {
  return (
    <ProtectedRoute requiredPermission="MANAGE_PAYROLL">
      <ManagePayrollPageContent />
    </ProtectedRoute>
  );
}

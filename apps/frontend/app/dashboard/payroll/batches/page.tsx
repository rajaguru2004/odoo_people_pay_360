'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  Plus,
  Users,
  Trash2,
  Edit2,
  Play,
  Search,
  Building2,
  Check,
  X,
  Loader2,
  FileText,
  UserPlus,
  Info,
  ChevronDown
} from 'lucide-react';
import payrollBatchService from '@/services/payrollBatchService';
import employeeService from '@/services/employeeService';
import departmentService from '@/services/departmentService';
import { PayrollBatch } from '@/types/payrollBatch';
import { Employee } from '@/types/employee';
import { Department } from '@/types/department';
import { toast } from '@/lib/toast';
import { useConfirm } from '@/hooks/useConfirm';
import { usePageHeader } from '@/hooks/usePageHeader';
import PageActionRow from '@/components/common/PageActionRow';
import ProtectedRoute from '@/components/auth/ProtectedRoute';

function PayrollBatchesPageContent() {
  const router = useRouter();
  const t = useTranslations('payrollBatchesPage');
  const tc = useTranslations('common');
  const { confirm, ConfirmDialog, closeModal, setLoading: setConfirmLoading } = useConfirm();

  // The one heading for this route, rendered by TopHeader.
  usePageHeader(t('title'), t('subtitle'));

  // State
  const [batches, setBatches] = useState<PayrollBatch[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Form State
  const [editingBatch, setEditingBatch] = useState<PayrollBatch | null>(null);
  const [batchName, setBatchName] = useState('');
  const [batchDescription, setBatchDescription] = useState('');
  const [selectedEmployeeIds, setSelectedEmployeeIds] = useState<string[]>([]);
  
  // Search & Filter in Modal
  const [modalSearchQuery, setModalSearchQuery] = useState('');
  const [modalDeptFilter, setModalDeptFilter] = useState('');

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      setLoading(true);
      const [batchesRes, employeesRes, deptsRes] = await Promise.all([
        payrollBatchService.getAll(),
        employeeService.getAll({ status: 'ACTIVE', limit: 500 }),
        departmentService.getAll()
      ]);
      setBatches(batchesRes.data || []);
      setEmployees(employeesRes.data || []);
      setDepartments(deptsRes.data || []);
    } catch (error) {
      console.error('Failed to fetch data:', error);
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleOpenCreateModal = () => {
    setEditingBatch(null);
    setBatchName('');
    setBatchDescription('');
    setSelectedEmployeeIds([]);
    setModalSearchQuery('');
    setModalDeptFilter('');
    setModalOpen(true);
  };

  const handleOpenEditModal = async (batch: PayrollBatch) => {
    try {
      setLoading(true);
      const res = await payrollBatchService.getById(batch.id);
      const fullBatch = res.data;
      
      setEditingBatch(fullBatch);
      setBatchName(fullBatch.name);
      setBatchDescription(fullBatch.description || '');
      setSelectedEmployeeIds(fullBatch.members?.map(m => m.employeeId) || []);
      setModalSearchQuery('');
      setModalDeptFilter('');
      setModalOpen(true);
    } catch (error) {
      console.error('Failed to load batch details:', error);
      toast.error(t('loadDetailsFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleSaveBatch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!batchName.trim()) {
      toast.error(t('nameRequired'));
      return;
    }
    if (selectedEmployeeIds.length === 0) {
      toast.error(t('atLeastOneEmployee'));
      return;
    }

    try {
      setSubmitting(true);
      if (editingBatch) {
        await payrollBatchService.update(editingBatch.id, {
          name: batchName,
          description: batchDescription,
          employeeIds: selectedEmployeeIds
        });
        toast.success(t('updateSuccess'));
      } else {
        await payrollBatchService.create({
          name: batchName,
          description: batchDescription,
          employeeIds: selectedEmployeeIds
        });
        toast.success(t('createSuccess'));
      }
      setModalOpen(false);
      fetchData();
    } catch (error: any) {
      console.error('Failed to save batch:', error);
      toast.error(error?.message || t('saveFailedFallback'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteBatch = async (batch: PayrollBatch) => {
    const confirmed = await confirm({
      title: t('deleteConfirmTitle'),
      message: t('deleteConfirmMessage', { name: batch.name }),
      confirmText: t('deleteConfirmText'),
      type: 'danger'
    });

    if (!confirmed) return;

    try {
      setConfirmLoading(true);
      await payrollBatchService.delete(batch.id);
      closeModal();
      toast.success(t('deleteSuccess'));
      fetchData();
    } catch (error: any) {
      console.error('Failed to delete batch:', error);
      closeModal();
      toast.error(error?.message || t('deleteFailedFallback'));
    }
  };

  const handleRunPayrollForBatch = (batch: PayrollBatch) => {
    // Redirect to run payroll page, pre-selecting this batch
    router.push(`/dashboard/payroll/manage?batchId=${batch.id}`);
  };

  // Filtered employees in modal
  const filteredEmployees = employees.filter(emp => {
    const matchesSearch = emp.fullName.toLowerCase().includes(modalSearchQuery.toLowerCase()) ||
      emp.employeeCode.toLowerCase().includes(modalSearchQuery.toLowerCase()) ||
      emp.position.toLowerCase().includes(modalSearchQuery.toLowerCase());
    const matchesDept = !modalDeptFilter || emp.departmentId === modalDeptFilter;
    return matchesSearch && matchesDept;
  });

  const toggleEmployeeSelection = (empId: string) => {
    setSelectedEmployeeIds(prev => 
      prev.includes(empId) ? prev.filter(id => id !== empId) : [...prev, empId]
    );
  };

  const selectAllFiltered = () => {
    const filteredIds = filteredEmployees.map(e => e.id);
    setSelectedEmployeeIds(prev => {
      const union = new Set([...prev, ...filteredIds]);
      return Array.from(union);
    });
  };

  const deselectAllFiltered = () => {
    const filteredIds = new Set(filteredEmployees.map(e => e.id));
    setSelectedEmployeeIds(prev => prev.filter(id => !filteredIds.has(id)));
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <ConfirmDialog />
      
      <PageActionRow
        action={
          <button
            data-testid="batch-create"
            onClick={handleOpenCreateModal}
            className="inline-flex items-center justify-center gap-2 bg-brand-primary hover:bg-brand-primary-dark text-text-on-brand font-semibold px-4 py-2.5 rounded-[--radius-button] shadow-xs transition-colors"
          >
            <Plus size={18} />
            {t('createBatchBtn')}
          </button>
        }
      />

      {/* Main Grid / Loader */}
      {loading && batches.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20">
          <Loader2 className="w-10 h-10 text-brand-primary animate-spin" />
          <p className="text-text-muted mt-4 text-sm font-medium">{t('loadingBatches')}</p>
        </div>
      ) : batches.length === 0 ? (
        <div className="bg-surface-card border border-surface-border rounded-[--radius-card] p-12 text-center shadow-xs flex flex-col items-center justify-center">
          <div className="w-16 h-16 rounded-full bg-surface-page flex items-center justify-center text-text-muted mb-4">
            <Users size={32} />
          </div>
          <h3 className="text-lg font-bold text-text-heading">{t('emptyTitle')}</h3>
          <p className="text-text-muted text-sm mt-2 max-w-md mx-auto">
            {t('emptyDesc')}
          </p>
          <button
            data-testid="batch-create-first"
            onClick={handleOpenCreateModal}
            className="mt-6 inline-flex items-center gap-2 bg-brand-primary hover:bg-brand-primary-dark text-text-on-brand font-semibold px-4 py-2 rounded-[--radius-button] transition-all"
          >
            <Plus size={18} />
            {t('createFirstBatchBtn')}
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {batches.map((batch) => (
            <div
              key={batch.id}
              data-testid="batch-card"
              data-batch-id={batch.id}
              data-batch-name={batch.name}
              data-member-count={batch._count?.members ?? 0}
              className="bg-surface-card border border-surface-border rounded-[--radius-card] p-6 shadow-xs hover:shadow-md hover:border-surface-border transition-all flex flex-col justify-between"
            >
              <div>
                <div className="flex justify-between items-start gap-4">
                  <h3 className="text-base font-bold text-text-heading truncate" title={batch.name}>
                    {batch.name}
                  </h3>
                  <span className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[--radius-badge] text-xs font-semibold bg-status-info-bg text-status-info">
                    <Users size={12} />
                    {t('membersCount', { count: batch._count?.members ?? 0 })}
                  </span>
                </div>

                <p className="text-text-muted text-sm mt-2 line-clamp-2 min-h-[40px]">
                  {batch.description || t('noDescription')}
                </p>
              </div>

              <div className="mt-6 pt-4 border-t border-surface-border flex items-center justify-between gap-2">
                <div className="flex items-center gap-1">
                  <button
                    data-testid="batch-edit"
                    onClick={() => handleOpenEditModal(batch)}
                    className="p-2 text-text-muted hover:text-text-heading hover:bg-surface-page rounded-[--radius-button] transition-colors"
                    title={t('editBatchTooltip')}
                  >
                    <Edit2 size={16} />
                  </button>
                  <button
                    data-testid="batch-delete"
                    onClick={() => handleDeleteBatch(batch)}
                    className="p-2 text-text-muted hover:text-status-error hover:bg-status-error-bg rounded-[--radius-button] transition-colors"
                    title={t('deleteBatchTooltip')}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>

                <button
                  data-testid="batch-run-payroll"
                  onClick={() => handleRunPayrollForBatch(batch)}
                  className="inline-flex items-center gap-1.5 bg-surface-page hover:bg-brand-primary hover:text-text-on-brand text-text-heading font-semibold px-3 py-1.5 rounded-[--radius-button] border border-surface-border hover:border-brand-primary text-xs transition-all"
                >
                  <Play size={12} />
                  {t('runPayrollBtn')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Slide-over / Modal for Create/Edit */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 overflow-hidden" aria-labelledby="slide-over-title" role="dialog" aria-modal="true">
          <div className="absolute inset-0 overflow-hidden">
            {/* Background backdrop */}
            <div
              className="absolute inset-0 bg-black/40 transition-opacity"
              onClick={() => !submitting && setModalOpen(false)}
            />

            <div className="pointer-events-none fixed inset-y-0 end-0 flex max-w-full ps-10">
              <div className="pointer-events-auto w-screen max-w-2xl transform transition-transform duration-500 sm:duration-700">
                <form onSubmit={handleSaveBatch} className="flex h-full flex-col bg-surface-overlay shadow-2xl border-s border-surface-border">
                  {/* Header */}
                  <div className="bg-surface-page px-6 py-5 border-b border-surface-border flex items-center justify-between">
                    <div>
                      <h2 className="text-lg font-bold text-text-heading">
                        {editingBatch ? t('modalTitleEdit') : t('modalTitleCreate')}
                      </h2>
                      <p className="text-text-muted text-xs mt-1">
                        {t('modalSubtitle')}
                      </p>
                    </div>
                    <button
                      data-testid="batch-modal-close"
                      type="button"
                      disabled={submitting}
                      onClick={() => setModalOpen(false)}
                      className="text-text-muted hover:text-text-heading rounded-[--radius-button] p-1.5 hover:bg-surface-page"
                    >
                      <X size={20} />
                    </button>
                  </div>

                  {/* Body */}
                  <div className="flex-1 overflow-y-auto p-6 space-y-6">
                    {/* Basic Info */}
                    <div className="space-y-4">
                      <div>
                        <label htmlFor="name" className="block text-sm font-semibold text-text-heading mb-1.5">
                          {t('batchNameLabel')} <span className="text-status-error">*</span>
                        </label>
                        <input
                          type="text"
                          data-testid="batch-name"
                          id="name"
                          value={batchName}
                          onChange={(e) => setBatchName(e.target.value)}
                          placeholder={t('batchNamePlaceholder')}
                          required
                          className="w-full px-3 py-2 border border-surface-border rounded-[--radius-input] focus:outline-hidden focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary bg-surface-card text-text-body text-sm"
                        />
                      </div>
                      <div>
                        <label htmlFor="description" className="block text-sm font-semibold text-text-heading mb-1.5">
                          {tc('description')}
                        </label>
                        <textarea
                          id="description"
                          rows={3}
                          value={batchDescription}
                          onChange={(e) => setBatchDescription(e.target.value)}
                          placeholder={t('descriptionPlaceholder')}
                          className="w-full px-3 py-2 border border-surface-border rounded-[--radius-input] focus:outline-hidden focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary bg-surface-card text-text-body text-sm"
                        />
                      </div>
                    </div>

                    {/* Member Selection Panel */}
                    <div className="border-t border-surface-border pt-6">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
                        <div>
                          <label className="block text-sm font-bold text-text-heading">
                            {t('selectEmployeesLabel')}
                          </label>
                          <span className="text-xs text-text-muted">
                            {t('selectedCountOfTotal', { selected: selectedEmployeeIds.length, total: employees.length })}
                          </span>
                        </div>

                        {/* Quick Selection Buttons */}
                        <div className="flex items-center gap-2">
                          <button
                            data-testid="batch-select-filtered"
                            type="button"
                            onClick={selectAllFiltered}
                            className="px-2.5 py-1 text-xs border border-surface-border rounded-[--radius-button] hover:bg-surface-page font-semibold text-text-heading transition-colors"
                          >
                            {t('selectFilteredBtn')}
                          </button>
                          <button
                            data-testid="batch-deselect-filtered"
                            type="button"
                            onClick={deselectAllFiltered}
                            className="px-2.5 py-1 text-xs border border-surface-border rounded-[--radius-button] hover:bg-status-error-bg hover:text-status-error font-semibold text-text-heading transition-colors"
                          >
                            {t('clearFilteredBtn')}
                          </button>
                        </div>
                      </div>

                      {/* Search and Filters */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
                        {/* Search Input */}
                        <div className="relative">
                          <Search className="absolute start-3 top-2.5 h-4 w-4 text-text-muted" />
                          <input
                            type="text"
                            value={modalSearchQuery}
                            onChange={(e) => setModalSearchQuery(e.target.value)}
                            placeholder={t('searchByNamePlaceholder')}
                            className="w-full ps-9 pe-3 py-2 border border-surface-border rounded-[--radius-input] text-xs focus:ring-2 focus:ring-brand-primary/20 bg-surface-card text-text-body"
                          />
                        </div>

                        {/* Department Filter */}
                        <div className="relative">
                          <Building2 className="absolute start-3 top-2.5 h-4 w-4 text-text-muted z-10" />
                          <select
                            value={modalDeptFilter}
                            onChange={(e) => setModalDeptFilter(e.target.value)}
                            className="w-full ps-9 pe-8 py-2 border border-surface-border rounded-[--radius-input] text-xs focus:ring-2 focus:ring-brand-primary/20 bg-surface-card text-text-body appearance-none relative z-0"
                          >
                            <option value="">{t('allDepartmentsOption')}</option>
                            {departments.map((dept) => (
                              <option key={dept.id} value={dept.id}>
                                {dept.name}
                              </option>
                            ))}
                          </select>
                          <div className="pointer-events-none absolute inset-y-0 end-0 flex items-center px-3 text-text-muted z-10">
                            <ChevronDown size={16} />
                          </div>
                        </div>
                      </div>

                      {/* Employee List Grid */}
                      <div className="border border-surface-border rounded-[--radius-card] max-h-[350px] overflow-y-auto divide-y divide-surface-border custom-scrollbar">
                        {filteredEmployees.length === 0 ? (
                          <div className="p-8 text-center text-text-muted text-xs">
                            {t('noEmployeesMatching')}
                          </div>
                        ) : (
                           filteredEmployees.map((emp) => {
                            const isSelected = selectedEmployeeIds.includes(emp.id);
                            return (
                              <div
                                key={emp.id}
                                data-testid="batch-employee-row"
                                data-employee-id={emp.id}
                                data-selected={isSelected}
                                onClick={() => toggleEmployeeSelection(emp.id)}
                                className={`flex items-center justify-between p-3 cursor-pointer transition-colors ${
                                  isSelected ? 'bg-brand-primary/10' : 'hover:bg-surface-page'
                                }`}
                              >
                                <div className="flex items-center gap-3 min-w-0 flex-1">
                                  <div className="w-8 h-8 rounded-full bg-surface-page flex items-center justify-center font-bold text-text-heading text-xs shrink-0 select-none">
                                    {emp.fullName.substring(0, 2).toUpperCase()}
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <p className="text-xs font-bold text-text-heading truncate">
                                      {emp.fullName}
                                    </p>
                                    <p className="text-[10px] text-text-muted mt-0.5 truncate">
                                      {emp.employeeCode} • {emp.position} • <span className="font-semibold text-text-heading">{emp.department?.name || t('noDept')}</span>
                                    </p>
                                  </div>
                                </div>

                                <div className="flex items-center gap-3 shrink-0 ms-4">
                                  <div
                                    className={`w-5 h-5 rounded-md border flex items-center justify-center shrink-0 transition-all ${
                                      isSelected
                                        ? 'bg-brand-primary border-brand-primary text-text-on-brand'
                                        : 'border-surface-border'
                                    }`}
                                  >
                                    {isSelected && <Check size={12} strokeWidth={3} />}
                                  </div>
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Footer */}
                  <div className="border-t border-surface-border px-6 py-4 bg-surface-page flex items-center justify-end pe-20 gap-3 shrink-0">
                    <button
                      data-testid="batch-modal-cancel"
                      type="button"
                      disabled={submitting}
                      onClick={() => setModalOpen(false)}
                      className="px-4 py-2 border border-surface-border rounded-[--radius-button] hover:bg-surface-page text-text-heading font-semibold text-sm transition-colors"
                    >
                      {tc('cancel')}
                    </button>
                    <button
                      data-testid="batch-modal-save"
                      type="submit"
                      disabled={submitting}
                      className="px-5 py-2 bg-brand-primary hover:bg-brand-primary-dark disabled:opacity-50 text-text-on-brand font-semibold text-sm rounded-[--radius-button] shadow-xs transition-colors flex items-center gap-2"
                    >
                      {submitting ? (
                        <>
                          <Loader2 size={16} className="animate-spin text-text-on-brand" />
                          {tc('saving')}
                        </>
                      ) : (
                        t('saveBatchBtn')
                      )}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * MANAGE_PAYROLL, matching the server: `GET /payrolls` and every write door on it
 * admit ADMIN and HR_MANAGER only. Without this the page rendered its chrome,
 * its stat cards and its action buttons for a manager or an employee and then
 * fired requests the API refused — a screen that looks usable and is not.
 */
export default function PayrollBatchesPage() {
  return (
    <ProtectedRoute requiredPermission="MANAGE_PAYROLL">
      <PayrollBatchesPageContent />
    </ProtectedRoute>
  );
}

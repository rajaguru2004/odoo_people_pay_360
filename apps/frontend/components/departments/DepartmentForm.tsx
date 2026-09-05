'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Building2, X, AlertCircle, CheckCircle2, Users, Crown } from 'lucide-react';
import { motion } from 'framer-motion';
import { useTranslations } from 'next-intl';
import PageActionRow from '@/components/common/PageActionRow';
import { usePageHeader } from '@/hooks/usePageHeader';
import departmentService from '@/services/departmentService';
import employeeService from '@/services/employeeService';
import departmentChangeRequestService from '@/services/departmentChangeRequestService';
import { Department } from '@/types/department';
import { Employee } from '@/types/employee';
import { getApiErrorMessage } from '@/lib/apiError';

function buildDepartmentSchema(t: (key: string) => string) {
  return z.object({
    code: z.string().min(1, t('zodCodeRequired')).max(50, t('zodCodeMaxLength')),
    name: z.string().min(1, t('zodNameRequired')).max(255, t('zodNameMaxLength')),
    description: z.string().optional(),
    parentId: z.string().optional(),
    managerId: z.string().optional(),
  });
}

type DepartmentFormData = z.infer<ReturnType<typeof buildDepartmentSchema>>;

interface DepartmentFormProps {
  mode: 'create' | 'edit';
  departmentId?: string;
}

export default function DepartmentForm({ mode, departmentId }: DepartmentFormProps) {
  const router = useRouter();
  const t = useTranslations('departmentForm');
  const tc = useTranslations('common');

  // Both /new and /[id]/edit route through this form, so the heading is
  // mode-conditional. TopHeader renders it; the form must not repeat it.
  usePageHeader(
    mode === 'create' ? t('createHeading') : t('editHeading'),
    mode === 'create' ? t('createSubtitle') : t('editSubtitle'),
  );
  const [loading, setLoading] = useState(false);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loadingData, setLoadingData] = useState(mode === 'edit');
  const [loadingSelects, setLoadingSelects] = useState(true);
  const [currentDepartment, setCurrentDepartment] = useState<Department | null>(null);
  const [selectedManagerId, setSelectedManagerId] = useState<string>('');
  const [submitError, setSubmitError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors },
    reset,
    watch,
  } = useForm<DepartmentFormData>({
    resolver: async (values, context, options) =>
      zodResolver(buildDepartmentSchema(t))(values, context, options),
  });

  const watchedParentId = watch('parentId') ?? '';

  useEffect(() => {
    const loadData = async () => {
      let dept: Department | null = null;

      // For edit mode, fetch department first to get parentId
      if (mode === 'edit' && departmentId) {
        dept = await fetchDepartment();
        // After department is loaded, fetch employees with filter
        await fetchEmployees(dept);
      } else {
        // For create mode, just fetch all employees
        await fetchEmployees();
      }

      // Fetch departments list
      await fetchDepartments(dept);
      setLoadingSelects(false);
    };
    
    setLoadingSelects(true);
    loadData();
  }, [mode, departmentId]);

  const fetchDepartment = async () => {
    if (!departmentId) return null;

    try {
      setLoadingData(true);
      const response = await departmentService.getById(departmentId);
      const dept = response.data;
      setCurrentDepartment(dept);
      setSelectedManagerId(dept.managerId || '');
      reset({
        code: dept.code,
        name: dept.name,
        description: dept.description || '',
        parentId: dept.parentId || '',
        managerId: dept.managerId || '',
      });
      return dept; // Return department data
    } catch (error) {
      console.error('Failed to fetch department:', error);
      alert(t('noDepartmentFound'));
      router.push('/dashboard/departments');
      return null;
    } finally {
      setLoadingData(false);
    }
  };

  const fetchEmployees = async (deptData?: any) => {
    try {
      // Get all active employees first
      const response: any = await employeeService.getAll({ status: 'ACTIVE', limit: 100 });
      
      // Handle multiple response formats
      let allEmployees: Employee[] = [];
      
      if (response) {
        if (Array.isArray(response.data)) {
          allEmployees = response.data;
        } else if (response.data?.data && Array.isArray(response.data.data)) {
          allEmployees = response.data.data;
        } else if (response.data?.employees && Array.isArray(response.data.employees)) {
          allEmployees = response.data.employees;
        }
      }
      
      // Filter eligible employees:
      // 1. Employees in current department
      // 2. Employees in parent department (if exists)
      let eligibleEmployees = allEmployees;
      
      if (mode === 'edit' && deptData && departmentId) {
        eligibleEmployees = allEmployees.filter(emp => {
          const empDeptId = emp.departmentId || emp.department?.id;

          if (empDeptId === departmentId) {
            return true;
          }

          if (deptData.parentId && empDeptId === deptData.parentId) {
            return true;
          }

          return false;
        });

        // Empty department (no members yet, e.g. freshly created) has no eligible
        // candidates — fall back to all active employees so a head can still be
        // assigned instead of the dropdown being empty.
        if (eligibleEmployees.length === 0) {
          eligibleEmployees = allEmployees;
        }
      }

      setEmployees(eligibleEmployees);
    } catch (error: any) {
      setEmployees([]);
    }
  };

  const fetchDepartments = async (deptData?: Department | null) => {
    try {
      const response: any = await departmentService.getAll();
      
      let allDepts: Department[] = [];
      
      if (response) {
        if (Array.isArray(response.data)) {
          allDepts = response.data;
        } else if (response.data?.data && Array.isArray(response.data.data)) {
          allDepts = response.data.data;
        }
      }
      
      // Only top-level departments can act as a superior: the backend caps the
      // hierarchy at 2 levels, so a department that already has a parent is not
      // a valid option. In edit mode the department itself is excluded too
      // (its own children are already excluded by the top-level rule), while the
      // currently assigned parent is always kept so the select never silently
      // falls back to "None (top level)".
      const currentParentId = deptData?.parentId;
      const filtered = allDepts.filter((d) => {
        if (mode === 'edit' && d.id === departmentId) return false;
        if (d.id === currentParentId) return true;
        return !d.parentId;
      });

      setDepartments(filtered);
    } catch (error: any) {
      setDepartments([]);
    }
  };

  const onSubmit = async (data: DepartmentFormData) => {
    setSubmitError(null);
    try {
      // Check if manager is changing
      const isManagerChanging = mode === 'edit' && 
        data.managerId !== (currentDepartment?.managerId || '');
      
      // If manager is changing in edit mode, create change request instead
      if (isManagerChanging && mode === 'edit' && departmentId) {
        const oldManager = currentDepartment?.manager;
        const newManager = employees.find(e => e.id === data.managerId);
        
        const confirmMessage = oldManager && newManager
          ? t('confirmChangeManager', { oldName: oldManager.fullName, newName: newManager.fullName })
          : newManager
          ? t('confirmSetManager', { newName: newManager.fullName })
          : t('confirmRemoveManager', { oldName: oldManager?.fullName || '' });

        const confirmed = window.confirm(confirmMessage);
        if (!confirmed) return;
        
        setLoading(true);

        // Order matters, and this order is the fix for a real trap.
        //
        // The request used to be raised FIRST. When the update that follows was
        // refused — a duplicate code, an illegal parent — the user was told the
        // save had failed while a PENDING request they were never told about had
        // already been opened. Their retry then hit "there is already a pending
        // change request for this department" and the form offered no way out.
        //
        // Writing the plain fields first means a refusal leaves nothing behind.
        await departmentService.update(departmentId, {
          code: data.code,
          name: data.name,
          description: data.description,
          // null (not undefined) so clearing the superior detaches the
          // department to top level instead of being dropped from the body.
          parentId: data.parentId || null,
        });

        // Only then the head change, which is a request rather than a save.
        await departmentChangeRequestService.createChangeRequest(departmentId, {
          requestType: 'CHANGE_MANAGER',
          newManagerId: data.managerId || undefined,
          reason: t('changeRequestReason', { deptName: data.name, newName: newManager?.fullName || t('changeRequestReasonNone') }),
          effectiveDate: new Date().toISOString(),
        });

        alert(t('managerChangeSuccess'));
        router.push('/dashboard/departments');
        return;
      }
      
      setLoading(true);
      if (mode === 'create') {
        await departmentService.create({
          ...data,
          parentId: data.parentId || undefined,
          managerId: data.managerId || undefined,
        });
        alert(t('createSuccess'));
      } else if (departmentId) {
        await departmentService.update(departmentId, {
          ...data,
          parentId: data.parentId || null,
          managerId: data.managerId || undefined,
        });
        alert(t('updateSuccess'));
      }
      router.push('/dashboard/departments');
    } catch (error: any) {
      console.error('Failed to save department:', error);
      // Surface the backend's specific reason (duplicate code, invalid parent,
      // validation failures, manager ineligibility, ...) instead of a generic
      // message. The axios interceptor rejects with a flat ApiError, so the real
      // text lives on error.message — getApiErrorMessage handles that + arrays.
      const message = getApiErrorMessage(error, t('saveFailed'));
      setSubmitError(message);
      // Scroll the banner into view so the user sees why the save failed.
      if (typeof window !== 'undefined') {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    } finally {
      setLoading(false);
    }
  };

  if (loadingData) {
    return (
      <div className="animate-pulse space-y-6">
        <div className="h-8 bg-slate-200 rounded w-64">{/* neutral */}</div>
        <div className="bg-surface-card rounded-[--radius-card] p-8 space-y-6">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="h-12 bg-slate-100 rounded">{/* neutral */}</div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* The heading itself is declared to TopHeader above; only the back
          affordance belongs on the page. */}
      <PageActionRow
        onBack={() => router.back()}
      />

      {/* Submit error banner — shows the backend's specific reason */}
      {submitError && (
        <div
          data-testid="dept-form-error"
          role="alert"
          className="flex items-start gap-3 rounded-[--radius-card] border-2 border-status-error/30 bg-status-error-bg/40 p-4"
        >
          <AlertCircle className="text-status-error shrink-0 mt-0.5" size={20} />
          <div className="flex-1">
            <p className="text-sm font-semibold text-status-error">{t('saveFailed')}</p>
            <p className="text-sm text-status-error/90 mt-0.5">{submitError}</p>
          </div>
          <button
            type="button"
            onClick={() => setSubmitError(null)}
            className="text-status-error/70 hover:text-status-error transition-colors"
            aria-label={tc('close')}
          >
            <X size={18} />
          </button>
        </div>
      )}

      {/* Form */}
      <form
        onSubmit={handleSubmit(onSubmit)}
        className="bg-surface-card rounded-[--radius-card] border-2 border-surface-border shadow-xl overflow-hidden"
      >
        <div className="p-8 space-y-8">
          {/* Section 1: Basic Info */}
          <div className="space-y-6">
            <div className="flex items-center gap-3 pb-4 border-b-2 border-surface-border">
              <div className="w-12 h-12 rounded-[--radius-card] bg-gradient-to-r from-brand-primary to-brand-primary-dark flex items-center justify-center shadow-lg">
                <Building2 className="text-text-on-brand" size={24} />
              </div>
              <div>
                <h2 className="text-lg font-bold text-text-heading">{t('basicInfoHeading')}</h2>
                <p className="text-sm text-text-muted">{t('basicInfoDesc')}</p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Code */}
              <div className="space-y-2">
                <label className="block text-sm font-semibold text-text-body">
                  {t('codeLabel')} <span className="text-status-error">*</span>
                </label>
                <div className="relative">
                  <input
                    type="text"
                    data-testid="dept-code" {...register('code')}
                    placeholder={t('codePlaceholder')}
                    className={`w-full px-4 py-3.5 ps-11 border-2 rounded-[--radius-input] font-medium transition-all ${
                      errors.code
                        ? 'border-status-error bg-status-error-bg/35 focus:border-status-error focus:ring-4 focus:ring-status-error/20 text-text-body bg-surface-card'
                        : 'border-surface-border bg-surface-card hover:border-surface-border/85 focus:border-brand-primary focus:ring-4 focus:ring-brand-primary/20 text-text-body'
                    }`}
                  />
                  <div className="absolute start-4 top-1/2 -translate-y-1/2">
                    <Building2 size={16} className={errors.code ? 'text-status-error' : 'text-text-muted'} />
                  </div>
                </div>
                {errors.code && (
                  <motion.div
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex items-center gap-2 text-status-error text-sm font-medium"
                  >
                    <AlertCircle size={14} />
                    <span>{errors.code.message}</span>
                  </motion.div>
                )}
                <p className="text-xs text-text-muted">{t('codeHelper')}</p>
              </div>

              {/* Name */}
              <div className="space-y-2">
                <label className="block text-sm font-semibold text-text-body">
                  {t('nameLabel')} <span className="text-status-error">*</span>
                </label>
                <div className="relative">
                  <input
                    type="text"
                    data-testid="dept-name" {...register('name')}
                    placeholder={t('namePlaceholder')}
                    className={`w-full px-4 py-3.5 ps-11 border-2 rounded-[--radius-input] font-medium transition-all ${
                      errors.name
                        ? 'border-status-error bg-status-error-bg/35 focus:border-status-error focus:ring-4 focus:ring-status-error/20 text-text-body bg-surface-card'
                        : 'border-surface-border bg-surface-card hover:border-surface-border/85 focus:border-brand-primary focus:ring-4 focus:ring-brand-primary/20 text-text-body'
                    }`}
                  />
                  <div className="absolute start-4 top-1/2 -translate-y-1/2">
                    <Building2 size={16} className={errors.name ? 'text-red-400' : 'text-text-muted'} />
                  </div>
                </div>
                {errors.name && (
                  <motion.div
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex items-center gap-2 text-status-error text-sm font-medium"
                  >
                    <AlertCircle size={14} />
                    <span>{errors.name.message}</span>
                  </motion.div>
                )}
                <p className="text-xs text-text-muted">{t('nameHelper')}</p>
              </div>
            </div>

            {/* Description */}
            <div className="space-y-2">
              <label className="block text-sm font-semibold text-text-body">
                {tc('description')}
              </label>
              <textarea
                data-testid="dept-description" {...register('description')}
                rows={4}
                placeholder={t('descriptionPlaceholder')}
                className="w-full px-4 py-3.5 border-2 border-surface-border rounded-[--radius-input] font-medium bg-surface-card hover:border-surface-border/85 focus:border-brand-primary focus:ring-4 focus:ring-brand-primary/20 transition-all resize-none text-text-body"
              />
              <p className="text-xs text-text-muted">{t('descriptionHelper')}</p>
            </div>
          </div>

          {/* Section 2: Organization Structure */}
          <div className="space-y-6">
            <div className="flex items-center gap-3 pb-4 border-b-2 border-surface-border">
              <div className="w-12 h-12 rounded-[--radius-card] bg-gradient-to-r from-brand-accent to-brand-accent-dark flex items-center justify-center shadow-lg">
                <Users className="text-text-on-accent" size={24} />
              </div>
              <div>
                <h2 className="text-lg font-bold text-text-heading">{t('orgStructureHeading')}</h2>
                <p className="text-sm text-text-muted">{t('orgStructureDesc')}</p>
              </div>
            </div>

            {/* Current Manager Display (Edit mode only) */}
            {mode === 'edit' && currentDepartment && (
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-brand-primary-light/10 border-2 border-brand-primary/20 rounded-[--radius-card] p-6 shadow-sm"
              >
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <Crown className="text-brand-primary" size={20} />
                    <h3 className="font-bold text-text-heading">{t('currentHead')}</h3>
                  </div>
                  {currentDepartment._count && (
                    <div className="px-3 py-1 bg-brand-primary-light/20 text-brand-primary rounded-[--radius-badge] text-xs font-semibold">
                      {t('managementEmployeesCount', { count: currentDepartment._count.employees })}
                    </div>
                  )}
                </div>
                {currentDepartment.manager ? (
                  <div className="flex items-center gap-4 bg-surface-card rounded-[--radius-card] p-4 border border-brand-primary/20">
                    <div className="w-14 h-14 rounded-[--radius-card] bg-gradient-to-br from-brand-primary to-brand-primary-dark flex items-center justify-center text-text-on-brand font-bold text-xl shadow-lg">
                      {currentDepartment.manager.fullName.charAt(0)}
                    </div>
                    <div className="flex-1">
                      <p className="font-bold text-text-heading">{currentDepartment.manager.fullName}</p>
                      <p className="text-sm text-text-body">{currentDepartment.manager.position}</p>
                      <p className="text-xs text-text-muted">{t('staffCodeLabel')}{currentDepartment.manager.employeeCode}</p>
                    </div>
                  </div>
                ) : (
                  <div className="bg-surface-card rounded-[--radius-card] p-4 border border-surface-border text-center">
                    <AlertCircle className="mx-auto text-text-muted mb-2" size={24} />
                    <p className="text-sm text-text-body">{t('noDeptHead')}</p>
                  </div>
                )}
              </motion.div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Parent Department */}
              <div className="space-y-2">
                <label className="block text-sm font-semibold text-text-body">
                  {t('superiorDeptLabel')}
                </label>
                <div className="relative">
                  <select
                    data-testid="dept-parent"
                    {...register('parentId')}
                    disabled={loadingSelects}
                    className="w-full px-4 py-3.5 ps-11 pe-10 border-2 border-surface-border rounded-[--radius-input] font-medium bg-surface-card hover:border-surface-border/85 focus:border-brand-accent focus:ring-4 focus:ring-brand-accent/20 transition-all appearance-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-slate-50 text-text-body"
                  >
                    <option value="">{loadingSelects ? t('loadingOption') : t('noneTopLevel')}</option>
                    {departments.map((dept) => (
                      <option key={dept.id} value={dept.id}>
                        {dept.name} ({dept.code})
                      </option>
                    ))}
                  </select>
                  <div className="absolute start-4 top-1/2 -translate-y-1/2 pointer-events-none">
                    <Users size={16} className="text-text-muted" />
                  </div>
                  <div className="absolute end-4 top-1/2 -translate-y-1/2 pointer-events-none">
                    {loadingSelects ? (
                      <div className="w-4 h-4 border-2 border-slate-300 border-t-slate-600 rounded-full animate-spin"></div> /* neutral */
                    ) : (
                      <svg className="w-5 h-5 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    )}
                  </div>
                </div>
                {/* Parent Change Warning — the backend rejects a parent change
                    on a department that still has employees, so surface the
                    constraint before the user hits save. */}
                {mode === 'edit' &&
                  watchedParentId !== (currentDepartment?.parentId || '') &&
                  (currentDepartment?._count?.employees || 0) > 0 && (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      data-testid="dept-parent-warning"
                      className="bg-status-error-bg/40 border-2 border-status-error/30 rounded-[--radius-card] p-3 mt-2"
                    >
                      <div className="flex items-start gap-2">
                        <AlertCircle className="text-status-error flex-shrink-0 mt-0.5" size={16} />
                        <div className="text-xs text-status-error">
                          <p className="font-semibold mb-1">{t('warningChangingSuperior')}</p>
                          <p>
                            {t('warningChangingSuperiorDesc', {
                              count: currentDepartment?._count?.employees || 0,
                            })}
                          </p>
                        </div>
                      </div>
                    </motion.div>
                  )}
                <p className="text-xs text-text-muted">{t('belongsToDeptHelper')}</p>
              </div>

              {/* Manager */}
              <div className="space-y-2">
                <label className="block text-sm font-semibold text-text-body">
                  {t('headOfDeptLabel')}{mode === 'edit' && t('changeSuffix')}
                </label>
                <div className="relative">
                  <select
                    data-testid="dept-manager"
                    {...register('managerId')}
                    disabled={loadingSelects}
                    value={selectedManagerId}
                    onChange={(e) => {
                      setSelectedManagerId(e.target.value);
                      register('managerId').onChange(e);
                    }}
                    className="w-full px-4 py-3.5 ps-11 pe-10 border-2 border-surface-border rounded-[--radius-input] font-medium bg-surface-card hover:border-surface-border/85 focus:border-brand-accent focus:ring-4 focus:ring-brand-accent/20 transition-all appearance-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed text-text-body"
                  >
                    <option value="">{loadingSelects ? t('loadingOption') : t('notSelected')}</option>
                    {employees.map((emp) => (
                      <option key={emp.id} value={emp.id}>
                        {emp.fullName} - {emp.position}
                      </option>
                    ))}
                  </select>
                  <div className="absolute start-4 top-1/2 -translate-y-1/2 pointer-events-none">
                    <Crown size={16} className="text-text-muted" />
                  </div>
                  <div className="absolute end-4 top-1/2 -translate-y-1/2 pointer-events-none">
                    {loadingSelects ? (
                      <div className="w-4 h-4 border-2 border-slate-300 border-t-slate-600 rounded-full animate-spin"></div> /* neutral */
                    ) : (
                      <svg className="w-5 h-5 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    )}
                  </div>
                </div>

                {/* Manager Change Warning */}
                {mode === 'edit' && selectedManagerId && selectedManagerId !== (currentDepartment?.managerId || '') && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    data-testid="dept-manager-warning"
                    className="bg-brand-accent/5 border-2 border-brand-accent/20 rounded-[--radius-card] p-3 mt-2"
                  >
                    <div className="flex items-start gap-2">
                      <AlertCircle className="text-brand-accent flex-shrink-0 mt-0.5" size={16} />
                      <div className="text-xs text-brand-accent">
                        <p className="font-semibold mb-1">{t('warningChangingHeads')}</p>
                        <p>{t('warningChangingHeadsDesc', { count: currentDepartment?._count?.employees || 0 })}</p>
                      </div>
                    </div>
                  </motion.div>
                )}
                <p className="text-xs text-text-muted">{t('managerHelper')}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Actions Footer */}
        <div className="px-8 py-6 bg-surface-page border-t-2 border-surface-border flex items-center justify-between">
          <button
            type="button"
            data-testid="dept-cancel"
            onClick={() => router.back()}
            className="group flex items-center gap-2 px-7 py-3.5 border-2 border-surface-border text-text-body rounded-[--radius-button] hover:bg-surface-card hover:border-surface-border-light hover:shadow-lg transition-all font-bold bg-surface-card"
          >
            <X size={20} className="group-hover:rotate-90 transition-transform" />
            <span>{tc('cancel')}</span>
          </button>
          <button
            type="submit"
            data-testid="dept-submit"
            disabled={loading}
            className="group flex items-center gap-3 px-10 py-3.5 bg-gradient-to-r from-brand-primary to-brand-primary-dark text-text-on-brand rounded-[--radius-button] hover:shadow-2xl hover:scale-105 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100 font-bold shadow-xl cursor-pointer"
          >
            {loading ? (
              <>
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                <span>{t('savingBtn')}</span>
              </>
            ) : (
              <>
                <CheckCircle2 size={20} className="group-hover:scale-110 transition-transform" />
                <span>{mode === 'create' ? t('createBtn') : t('saveChangesBtn')}</span>
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
}

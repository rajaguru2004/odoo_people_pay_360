'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Plus, Edit, Trash2, Save, X, Info } from 'lucide-react';
import salaryComponentService from '@/services/salaryComponentService';
import libraryService from '@/services/libraryService';
import { SalaryComponent, ComponentType } from '@/types/salaryComponent';
import { formatCurrency } from '@/utils/formatters';
import { toast } from '@/lib/toast';
import { useConfirm } from '@/hooks/useConfirm';
import {
  SALARY_COMPONENT_OPTIONS,
  SalaryComponentTypeOption,
  componentLabel,
  optionsFromLibrary,
  toComponentCode,
} from '@/utils/salaryComponentUtils';
import type { SalaryType } from '@/types/employee';
import { isDailyWage } from '@/utils/payBasis';
import { apiErrorMessage } from '@/utils/apiError';

interface SalaryStructureProps {
  employeeId: string;
  canEdit?: boolean;
  /**
   * The employee's pay basis. On a daily-wage employee the payroll engine
   * multiplies EVERY component by days worked, so each amount below is a
   * per-day figure, not a monthly one.
   */
  salaryType?: SalaryType;
  /**
   * The employee's contracted rate. Shown because it is NOT independent of the
   * list below: with no BASIC component the payroll engine uses this value as
   * the basic, and a BASIC component replaces it. Stating that relationship is
   * the whole reason someone can reason about the breakup at all.
   */
  baseSalary?: number | string | null;
  /** Drops the outer card so the panel can sit inside another one. */
  embedded?: boolean;
  /** Re-fetch when the parent changes something that affects the breakup. */
  refreshKey?: number;
}

const getColorForType = (type: string) => {
  const colors = [
    'bg-brand-primary-light/20 text-brand-primary',
    'bg-teal-100 text-teal-700',
    'bg-green-100 text-green-700',
    'bg-purple-100 text-purple-700',
    'bg-orange-100 text-orange-700',
    'bg-pink-100 text-pink-700',
    'bg-brand-primary-light/20 text-brand-primary-dark',
    'bg-yellow-100 text-yellow-700',
  ];
  let hash = 0;
  for (let i = 0; i < type.length; i++) {
    hash = type.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
};

export default function SalaryStructure({
  employeeId,
  canEdit = false,
  salaryType,
  baseSalary,
  embedded = false,
  refreshKey,
}: SalaryStructureProps) {
  const t = useTranslations('salaryStructure');
  const tc = useTranslations('common');
  // Shared pay-basis strings, consumed by utils/payBasis.ts helpers.
  const tp = useTranslations('payBasis');
  const daily = isDailyWage(salaryType);
  const { confirm, ConfirmDialog, closeModal, setLoading: setConfirmLoading } = useConfirm();
  const [components, setComponents] = useState<SalaryComponent[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [componentTypeOptions, setComponentTypeOptions] = useState<SalaryComponentTypeOption[]>(SALARY_COMPONENT_OPTIONS);
  const [formData, setFormData] = useState({
    componentType: 'BASIC' as ComponentType,
    amount: 0,
    note: '',
  });

  const fetchSalaryStructure = useCallback(async () => {
    try {
      setLoading(true);
      const response = await salaryComponentService.getByEmployee(employeeId);
      // PAYROLL_CONFIG rows are internal deduction-override bookkeeping (raw JSON
      // in `note`, amount always 0) — not a real pay line, so keep them out of
      // this editable list to avoid exposing/corrupting them via the generic form.
      setComponents(response.data.components.filter((c: SalaryComponent) => c.componentType !== 'PAYROLL_CONFIG'));
    } catch (error) {
      console.error('Failed to fetch salary structure:', error);
    } finally {
      setLoading(false);
    }
  }, [employeeId]);

  useEffect(() => {
    fetchSalaryStructure();
  }, [fetchSalaryStructure, refreshKey]);

  useEffect(() => {
    let cancelled = false;
    libraryService
      .getAll('SALARY_COMPONENT_TYPE', true)
      .then((response: any) => {
        if (cancelled) return;
        const options = optionsFromLibrary(response?.data);
        setComponentTypeOptions(options);
        setFormData((prev) => ({ ...prev, componentType: options[0].value }));
      })
      .catch(() => {
        if (!cancelled) setComponentTypeOptions(SALARY_COMPONENT_OPTIONS);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * The same split the payroll engine makes (`resolveContractedRates`): the
   * BASIC component is the basic and every other component is an allowance; with
   * no BASIC component the employee's contracted rate stands in as the basic.
   * Mirrored rather than re-invented, so the figure here is the figure that gets
   * paid.
   */
  const breakdown = useMemo(() => {
    const basicComponent = components.find((c) => c.componentType === 'BASIC');
    const allowanceRows = components.filter((c) => c.componentType !== 'BASIC');
    const fallbackBasic = Number(baseSalary) || 0;
    const basic = basicComponent ? Number(basicComponent.amount) : fallbackBasic;
    const allowances = allowanceRows.reduce((sum, c) => sum + Number(c.amount), 0);
    return {
      basic,
      allowances,
      gross: basic + allowances,
      basicIsFromBaseSalary: !basicComponent,
      fallbackBasic,
    };
  }, [components, baseSalary]);

  const handleAdd = async () => {
    try {
      await salaryComponentService.create({
        employeeId,
        ...formData,
        componentType: toComponentCode(String(formData.componentType)),
      });
      toast.success(t('addSuccess'));
      setShowAddModal(false);
      setFormData({ componentType: componentTypeOptions[0]?.value || 'BASIC', amount: 0, note: '' });
      fetchSalaryStructure();
    } catch (error: any) {
      console.error('Failed to add component:', error);
      const rawMsg = apiErrorMessage(error) ?? error?.message;
      const msg = Array.isArray(rawMsg) ? rawMsg.join(', ') : (rawMsg || t('addFailed'));
      toast.error(msg);
    }
  };

  const handleUpdate = async (id: string) => {
    try {
      await salaryComponentService.update(id, {
        amount: formData.amount,
        note: formData.note,
      });
      toast.success(t('updateSuccess'));
      setEditingId(null);
      fetchSalaryStructure();
    } catch (error: any) {
      console.error('Failed to update component:', error);
      const rawMsg = apiErrorMessage(error) ?? error?.message;
      const msg = Array.isArray(rawMsg) ? rawMsg.join(', ') : (rawMsg || t('updateFailed'));
      toast.error(msg);
    }
  };

  const handleDelete = async (id: string) => {
    const confirmed = await confirm({
      title: t('confirmDeleteTitle'),
      message: t('confirmDeleteDesc'),
      confirmText: tc('delete'),
      type: 'danger'
    });

    if (!confirmed) return;

    try {
      setConfirmLoading(true);
      await salaryComponentService.delete(id);
      closeModal();
      toast.success(t('deleteSuccess'));
      fetchSalaryStructure();
    } catch (error: any) {
      console.error('Failed to delete component:', error);
      closeModal();
      const rawMsg = apiErrorMessage(error) ?? error?.message;
      const msg = Array.isArray(rawMsg) ? rawMsg.join(', ') : (rawMsg || t('deleteFailed'));
      toast.error(msg);
    }
  };

  const startEdit = (component: SalaryComponent) => {
    setEditingId(component.id);
    setFormData({
      componentType: component.componentType,
      amount: Number(component.amount),
      note: component.note || '',
    });
  };

  const shell = embedded
    ? ''
    : 'bg-surface-card rounded-2xl p-6 border border-surface-border';

  if (loading) {
    return (
      <div className={shell}>
        <div className="animate-pulse space-y-4">
          <div className="h-6 bg-surface-border-light rounded w-1/3"></div>
          <div className="h-20 bg-surface-page rounded"></div>
          <div className="h-20 bg-surface-page rounded"></div>
        </div>
      </div>
    );
  }

  const perDay = daily ? tp('perDay') : '';

  return (
    <div className={shell}>
      <ConfirmDialog />
      <div className="flex items-center justify-between gap-4 mb-4">
        <div>
          {!embedded && <h3 className="text-xl font-bold text-text-heading">{t('title')}</h3>}
          <p className={`text-xs text-text-muted ${embedded ? '' : 'mt-1'}`}>{t('breakupHint')}</p>
        </div>
        {canEdit && (
          <button
            type="button"
            onClick={() => setShowAddModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-brand-primary text-text-on-brand rounded-[--radius-button] hover:bg-brand-primary-dark transition-colors shrink-0 text-sm font-medium"
          >
            <Plus size={16} /> {t('addButton')}
          </button>
        )}
      </div>

      {/* Basic / Allowances / Gross — the three numbers a payslip is built from. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        {[
          { label: t('basicLabel'), value: breakdown.basic, strong: false },
          { label: t('allowancesLabel'), value: breakdown.allowances, strong: false },
          { label: t('grossLabel'), value: breakdown.gross, strong: true },
        ].map((cell) => (
          <div
            key={cell.label}
            className={`rounded-xl border p-4 ${
              cell.strong
                ? 'border-brand-primary/30 bg-brand-primary/5'
                : 'border-surface-border bg-surface-page'
            }`}
          >
            <p className="text-xs text-text-muted">{cell.label}</p>
            <p
              className={`mt-1 font-bold ${
                cell.strong ? 'text-xl text-brand-primary-dark' : 'text-lg text-text-heading'
              }`}
            >
              {formatCurrency(cell.value)}
              {cell.value > 0 && daily && (
                <span className="text-xs font-normal text-text-muted">{perDay}</span>
              )}
            </p>
          </div>
        ))}
      </div>

      {/* Where the basic came from. Without this the two numbers look like they
          contradict each other whenever a BASIC component overrides the field. */}
      <div className="flex items-start gap-2 mb-4 px-3 py-2 rounded-lg bg-surface-page border border-surface-border">
        <Info size={14} className="mt-0.5 shrink-0 text-text-muted" />
        <p className="text-xs text-text-muted">
          {breakdown.basicIsFromBaseSalary
            ? t('basicFromBaseSalary')
            : t('basicFromComponent', {
                amount: formatCurrency(breakdown.fallbackBasic),
              })}
        </p>
      </div>

      {daily && (
        <p className="mb-4 text-xs text-status-warning font-medium">{t('perDayBanner')}</p>
      )}

      {/* Components List */}
      <div className="space-y-2">
        {components.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8 border-2 border-dashed border-surface-border rounded-xl text-center">
            <p className="text-sm text-text-body">{t('noComponentsYet')}</p>
            <p className="text-xs text-text-muted max-w-md">{t('emptyStateHint')}</p>
            {canEdit && (
              <button
                type="button"
                onClick={() => setShowAddModal(true)}
                className="text-sm text-brand-primary hover:underline font-medium"
              >
                {t('addFirstComponent')}
              </button>
            )}
          </div>
        ) : (
          components.map((component) => (
            <div key={component.id} className="flex items-center justify-between gap-3 p-3 border border-surface-border rounded-lg hover:bg-surface-page transition-colors">
              {editingId === component.id ? (
                <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <input type="number" min={0} value={formData.amount} onChange={(e) => setFormData({ ...formData, amount: Number(e.target.value) })} onWheel={(e) => e.currentTarget.blur()} className="px-3 py-2 border border-surface-border rounded-lg bg-surface-card text-text-body" placeholder={t('amountPlaceholder')} />
                  <input type="text" value={formData.note} onChange={(e) => setFormData({ ...formData, note: e.target.value })} className="px-3 py-2 border border-surface-border rounded-lg bg-surface-card text-text-body" placeholder={t('notesPlaceholder')} />
                </div>
              ) : (
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <span className={`px-3 py-1 rounded-lg text-xs font-semibold shrink-0 ${getColorForType(component.componentType)}`}>
                    {componentLabel(component.componentType, componentTypeOptions)}
                  </span>
                  <span className="text-sm text-text-muted truncate">{component.note}</span>
                </div>
              )}
              <div className="flex items-center gap-3 shrink-0">
                {editingId !== component.id && (
                  <span className="text-base font-bold text-text-heading">
                    {formatCurrency(Number(component.amount))}
                  </span>
                )}
                {canEdit && (
                  <div className="flex gap-1">
                    {editingId === component.id ? (
                      <>
                        <button type="button" onClick={() => handleUpdate(component.id)} aria-label={tc('save')} className="p-2 hover:bg-status-success-bg rounded-lg text-status-success">
                          <Save size={16} />
                        </button>
                        <button type="button" onClick={() => setEditingId(null)} aria-label={tc('cancel')} className="p-2 hover:bg-surface-page rounded-lg text-text-muted">
                          <X size={16} />
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" onClick={() => startEdit(component)} aria-label={tc('edit')} className="p-2 hover:bg-brand-primary-light/10 rounded-lg text-brand-primary">
                          <Edit size={16} />
                        </button>
                        <button type="button" onClick={() => handleDelete(component.id)} aria-label={tc('delete')} className="p-2 hover:bg-status-error-bg rounded-lg text-status-error">
                          <Trash2 size={16} />
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {canEdit && <p className="mt-3 text-xs text-text-muted">{t('typesFromLibraryHint')}</p>}

      {/* Add Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-surface-card rounded-2xl p-8 max-w-md w-full">
            <h3 className="text-xl font-bold text-text-heading mb-6">{t('addModalTitle')}</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-text-heading mb-2">
                  {t('typeLabel')} <span className="text-status-error">*</span>
                </label>
                <select
                  value={formData.componentType}
                  onChange={(e) => setFormData({ ...formData, componentType: e.target.value })}
                  className="w-full px-4 py-3 border border-surface-border rounded-lg bg-surface-card text-text-body focus:outline-none focus:ring-2 focus:ring-brand-primary/20"
                >
                  {componentTypeOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-text-muted">{t('typesFromLibraryHint')}</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-text-heading mb-2"> {t('amountLabel')} <span className="text-status-error">*</span> </label>
                <input type="number" min={0} value={formData.amount} onChange={(e) => setFormData({ ...formData, amount: Number(e.target.value) })} onWheel={(e) => e.currentTarget.blur()} className="w-full px-4 py-3 border border-surface-border rounded-lg bg-surface-card text-text-body focus:outline-none focus:ring-2 focus:ring-brand-primary/20" placeholder={t('enterAmount')} />
              </div>
              <div>
                <label className="block text-sm font-medium text-text-heading mb-2"> {t('noteLabel')} </label>
                <input type="text" value={formData.note} onChange={(e) => setFormData({ ...formData, note: e.target.value })} className="w-full px-4 py-3 border border-surface-border rounded-lg bg-surface-card text-text-body focus:outline-none focus:ring-2 focus:ring-brand-primary/20" placeholder={t('notesOptionalPlaceholder')} />
              </div>
            </div>
            <div className="flex gap-4 mt-6">
              <button type="button" onClick={handleAdd} className="flex-1 px-6 py-3 bg-brand-primary text-text-on-brand rounded-lg font-semibold hover:bg-brand-primary-dark transition-colors">
                {tc('add')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowAddModal(false);
                  setFormData({ componentType: componentTypeOptions[0]?.value || 'BASIC', amount: 0, note: '' });
                }}
                className="px-6 py-3 border border-surface-border text-text-heading rounded-lg hover:bg-surface-page transition-colors"
              >
                {tc('cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

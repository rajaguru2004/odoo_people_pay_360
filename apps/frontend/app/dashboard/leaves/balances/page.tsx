'use client';

import { useEffect, useState } from 'react';
import { Calendar, Users, Edit, Play, Loader2, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import leaveService from '@/services/leaveService';
import { LeaveBalance } from '@/types/leave';
import { toast } from '@/lib/toast';
import { useConfirm } from '@/hooks/useConfirm';
import { usePageHeader } from '@/hooks/usePageHeader';
import PageActionRow from '@/components/common/PageActionRow';

const LEAVE_TYPE_COLORS = [
  {
    header: 'bg-brand-primary/10 text-brand-primary border-brand-primary/20',
    dot: 'bg-brand-primary',
    value: 'text-brand-primary',
    low: 'text-status-error',
    badge: 'bg-brand-primary/10 border border-brand-primary/20',
    stat: 'bg-brand-primary/5 border-brand-primary/20 text-brand-primary',
    icon: 'text-brand-primary bg-brand-primary/10',
  },
  {
    header: 'bg-status-success/10 text-status-success border-status-success/20',
    dot: 'bg-status-success',
    value: 'text-status-success',
    low: 'text-status-error',
    badge: 'bg-status-success-bg border border-status-success/20',
    stat: 'bg-status-success/5 border-status-success/20 text-status-success',
    icon: 'text-status-success bg-status-success/10',
  },
  {
    header: 'bg-status-warning/10 text-status-warning border-status-warning/20',
    dot: 'bg-status-warning',
    value: 'text-status-warning',
    low: 'text-status-error',
    badge: 'bg-status-warning-bg border border-status-warning/20',
    stat: 'bg-status-warning/5 border-status-warning/20 text-status-warning',
    icon: 'text-status-warning bg-status-warning/10',
  },
  {
    header: 'bg-status-info/10 text-status-info border-status-info/20',
    dot: 'bg-status-info',
    value: 'text-status-info',
    low: 'text-status-error',
    badge: 'bg-status-info-bg border border-status-info/20',
    stat: 'bg-status-info/5 border-status-info/20 text-status-info',
    icon: 'text-status-info bg-status-info/10',
  },
  {
    header: 'bg-brand-accent/10 text-brand-accent border-brand-accent/20',
    dot: 'bg-brand-accent',
    value: 'text-brand-accent',
    low: 'text-status-error',
    badge: 'bg-brand-accent/10 border border-brand-accent/20',
    stat: 'bg-brand-accent/5 border-brand-accent/20 text-brand-accent',
    icon: 'text-brand-accent bg-brand-accent/10',
  },
  {
    header: 'bg-status-error/10 text-status-error border-status-error/20',
    dot: 'bg-status-error',
    value: 'text-status-error',
    low: 'text-status-error',
    badge: 'bg-status-error-bg border border-status-error/20',
    stat: 'bg-status-error/5 border-status-error/20 text-status-error',
    icon: 'text-status-error bg-status-error/10',
  },
];

function getColor(idx: number) {
  return LEAVE_TYPE_COLORS[idx % LEAVE_TYPE_COLORS.length];
}

function genderAllowed(restriction: string | null | undefined, employeeGender: string | null | undefined): boolean {
  if (!restriction) return true;
  if (!employeeGender) return false;
  return restriction.toUpperCase() === employeeGender.toUpperCase();
}

export default function LeaveBalancesPage() {
  const t = useTranslations('leaveBalancesPage');
  const tc = useTranslations('common');
  const { confirm, ConfirmDialog, closeModal, setLoading: setConfirmLoading } = useConfirm();

  // The one heading for this route, rendered by TopHeader.
  usePageHeader(t('title'), t('subtitle'));

  const [balances, setBalances] = useState<LeaveBalance[]>([]);
  const [leaveTypes, setLeaveTypes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  const [showEditModal, setShowEditModal] = useState(false);
  const [editBalance, setEditBalance] = useState<LeaveBalance | null>(null);
  const [editTypeBalances, setEditTypeBalances] = useState<Record<string, { allocated: number; carriedOver: number }>>({});

  useEffect(() => {
    fetchData();
  }, [selectedYear]);

  const fetchData = async () => {
    try {
      setLoading(true);
      const [balRes, typesRes] = await Promise.all([
        leaveService.getAllBalances(selectedYear),
        leaveService.getLeaveTypes()
      ]);
      setBalances(balRes.data || []);
      if (typesRes.success) {
        setLeaveTypes(typesRes.data || []);
      }
    } catch (error) {
      console.error('Failed to fetch leave data:', error);
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleRunAccrual = async () => {
    const confirmed = await confirm({
      title: t('confirmAccrualTitle'),
      message: t('confirmAccrualDesc'),
      confirmText: t('runAccrualBtn'),
      type: 'info'
    });
    if (!confirmed) return;
    try {
      setConfirmLoading(true);
      toast.info(t('processingAccrual'));
      const response = await leaveService.runAccrual();
      closeModal();
      const successCount = response.data?.success || 0;
      const failedCount = response.data?.failed || 0;
      const skippedCount = response.data?.skipped || 0;
      toast.success(t('accrualCompleted', { success: successCount, skipped: skippedCount, failed: failedCount }));
      fetchData();
    } catch (error: any) {
      console.error('Failed to run accrual:', error);
      closeModal();
      toast.error(error?.message || t('accrualFailed'));
    }
  };

  const handleResetToDefaults = async () => {
    const confirmed = await confirm({
      title: t('resetToDefaults'),
      message: t('confirmResetDesc', { year: selectedYear }),
      confirmText: t('resetBalancesBtn'),
      type: 'danger'
    });
    if (!confirmed) return;
    try {
      setConfirmLoading(true);
      await leaveService.setBulkDefaultBalances(selectedYear);
      closeModal();
      toast.success(t('resetSuccess', { year: selectedYear }));
      fetchData();
    } catch (error: any) {
      console.error('Failed to reset balances:', error);
      closeModal();
      toast.error(error?.message || t('resetFailed'));
    }
  };

  const activeLeaveTypes = leaveTypes.filter(lt => lt.affectsBalance !== false);

  const handleEditBalance = (balance: LeaveBalance) => {
    setEditBalance(balance);
    const empGender = balance.employee?.gender;
    const initialMap: Record<string, { allocated: number; carriedOver: number }> = {};
    activeLeaveTypes
      .filter(type => genderAllowed(type.genderRestriction, empGender))
      .forEach(type => {
        const ltb = balance.leaveTypeBalances?.find(b => b.leaveTypeKey === type.label);
        initialMap[type.label] = {
          allocated: ltb ? ltb.allocated : type.defaultDays || 0,
          carriedOver: ltb ? ltb.carriedOver : 0
        };
      });
    setEditTypeBalances(initialMap);
    setShowEditModal(true);
  };

  const handleSaveEdit = async () => {
    if (!editBalance) return;
    try {
      const updatePromises = Object.entries(editTypeBalances).map(([key, val]) =>
        leaveService.updateTypeBalance(editBalance.employeeId, selectedYear, key, val.allocated, val.carriedOver)
      );
      const annualVal = editTypeBalances['Annual Leave']?.allocated ?? editTypeBalances['Annual']?.allocated;
      const sickVal = editTypeBalances['Sick Leave']?.allocated ?? editTypeBalances['Sick']?.allocated;
      if (annualVal !== undefined || sickVal !== undefined) {
        const currentAnnual = annualVal !== undefined ? annualVal : editBalance.annualLeave;
        const currentSick = sickVal !== undefined ? sickVal : editBalance.sickLeave;
        await leaveService.updateBalance(editBalance.employeeId, selectedYear, currentAnnual, currentSick);
      }
      await Promise.all(updatePromises);
      toast.success(t('updateSuccess'));
      setShowEditModal(false);
      fetchData();
    } catch (error: any) {
      console.error('Failed to update balance:', error);
      toast.error(error?.response?.data?.message || error?.message || t('updateFailed'));
    }
  };

  const totalEmployees = balances.length;

  return (
    <>
      <ConfirmDialog />
      <div className="space-y-6">
        {/* Year picker + bulk actions. The title/description live in the sticky
            TopHeader (declared via usePageHeader above). */}
        <PageActionRow
          action={
            <div className="flex flex-wrap gap-3 items-center">
              <select
                data-testid="lbl-year"
                value={selectedYear}
                onChange={(e) => setSelectedYear(Number(e.target.value))}
                className="px-4 py-2 border border-surface-border rounded-[--radius-input] bg-surface-card focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary text-text-body"
              >
                {[2024, 2025, 2026, 2027].map(year => (
                  <option key={year} value={year}>{year}</option>
                ))}
              </select>
              <button
                data-testid="lbl-reset-defaults"
                onClick={handleResetToDefaults}
                className="flex items-center gap-2 px-4 py-2 border border-status-error/20 bg-status-error-bg text-status-error rounded-[--radius-button] font-semibold hover:opacity-90 transition-all text-sm shadow-sm"
              >
                {t('resetToDefaults')}
              </button>
              <button
                data-testid="lbl-run-accrual"
                onClick={handleRunAccrual}
                className="flex items-center gap-2 px-5 py-2 bg-brand-primary text-text-on-brand rounded-[--radius-button] font-semibold hover:bg-brand-primary-dark hover:shadow-lg transition-all text-sm"
              >
                <Play size={16} />
                {t('runAccrualHeaderBtn')}
              </button>
              <button
                data-testid="lbl-refresh"
                onClick={fetchData}
                className="flex items-center justify-center p-2 border border-surface-border bg-surface-card text-text-muted rounded-[--radius-button] hover:bg-surface-page transition-colors shadow-sm"
                title={tc('refresh')}
              >
                <RefreshCw size={18} />
              </button>
            </div>
          }
        />

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
          {/* Total employees card */}
          <div className="bg-brand-primary rounded-[--radius-card] p-5 text-text-on-brand shadow-sm relative overflow-hidden">
            <div className="absolute top-0 end-0 w-20 h-20 bg-white/10 rounded-full -translate-y-1/3 translate-x-1/3" />
            <div className="relative z-10">
              <div className="w-10 h-10 bg-white/20 rounded-[--radius-card] flex items-center justify-center mb-3">
                <Users size={20} />
              </div>
              <p className="text-text-on-brand/80 text-xs font-medium mb-1">{t('totalEmployeesStat')}</p>
              <p data-testid="lbl-stat-total" data-value={totalEmployees} className="text-3xl font-bold">{totalEmployees}</p>
              <p className="text-text-on-brand/70 text-[11px] font-medium mt-1">{t('totalEmployeesStatSub', { year: selectedYear })}</p>
            </div>
          </div>

          {activeLeaveTypes.map((type, idx) => {
            const color = getColor(idx);
            const totalRemaining = balances.reduce((sum, b) => {
              const ltb = b.leaveTypeBalances?.find(tb => tb.leaveTypeKey === type.label);
              if (ltb) return sum + ltb.remaining;
              if (type.label.toLowerCase().includes('annual')) {
                return sum + (b.remainingAnnual ?? (b.annualLeave + b.carriedOver - b.usedAnnual));
              }
              if (type.label.toLowerCase().includes('sick')) {
                return sum + (b.remainingSick ?? (b.sickLeave - b.usedSick));
              }
              return sum;
            }, 0);

            return (
              <div key={type.id} data-testid="lbl-stat-type" data-leave-type={type.label} data-remaining={totalRemaining} className={`bg-surface-card rounded-[--radius-card] p-5 border-2 shadow-sm hover:shadow-md transition-all ${color.badge}`}>
                <div className={`w-10 h-10 rounded-[--radius-card] flex items-center justify-center mb-3 ${color.icon}`}>
                  <Calendar size={18} />
                </div>
                <p className="text-text-muted text-xs font-medium mb-1 truncate">{type.label}</p>
                <p className={`text-3xl font-bold ${color.value}`}>{totalRemaining}</p>
                <p className="text-text-muted text-xs mt-1">{t('daysAcrossStaff')}</p>
              </div>
            );
          })}
        </div>

        {/* Legend */}
        {activeLeaveTypes.some(lt => lt.genderRestriction) && (
          <div data-testid="lbl-legend" className="flex flex-wrap items-center gap-4 text-xs text-text-muted bg-surface-card border border-surface-border rounded-[--radius-card] px-4 py-2.5">
            <span className="font-semibold text-text-body">{t('legendLabel')}</span>
            {activeLeaveTypes.filter(lt => lt.genderRestriction).map((type) => (
              <span key={type.id} className="flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${getColor(activeLeaveTypes.indexOf(type)).dot}`} />
                {type.label} {t('genderOnly', { gender: type.genderRestriction })}
              </span>
            ))}
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-surface-border" />
              {t('notApplicableLegend')}
            </span>
          </div>
        )}

        {/* Table */}
        <div className="bg-surface-card rounded-[--radius-card] border border-surface-border overflow-hidden shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-surface-page border-b border-surface-border">
                <tr>
                  <th className="px-5 py-4 text-start text-sm font-semibold text-text-heading sticky start-0 bg-surface-page z-10">{tc('employee')}</th>
                  <th className="px-5 py-4 text-start text-sm font-semibold text-text-heading">{tc('department')}</th>
                  {activeLeaveTypes.map((type, idx) => {
                    const color = getColor(idx);
                    return (
                      <th key={type.id} className={`px-5 py-3 text-center text-xs font-semibold whitespace-nowrap border-b-2 ${color.header}`}>
                        <div className="flex flex-col items-center gap-1">
                          <div className="flex items-center gap-1.5">
                            <span className={`w-2 h-2 rounded-full ${color.dot}`} />
                            <span>{type.label}</span>
                          </div>
                          <span className="text-[10px] font-normal opacity-70">
                            {t('remTotalHeader')}
                            {type.genderRestriction ? t('genderOnlySub', { gender: type.genderRestriction }) : ''}
                          </span>
                        </div>
                      </th>
                    );
                  })}
                  <th className="px-5 py-4 text-center text-sm font-semibold text-text-heading">{tc('actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {loading ? (
                  <tr>
                    <td data-testid="lbl-loading" colSpan={3 + activeLeaveTypes.length} className="px-6 py-12 text-center">
                      <Loader2 className="w-8 h-8 animate-spin text-brand-primary mx-auto" />
                    </td>
                  </tr>
                ) : balances.length === 0 ? (
                  <tr>
                    <td data-testid="lbl-empty" colSpan={3 + activeLeaveTypes.length} className="px-6 py-12 text-center text-text-muted">
                      {t('noEmployeeData')}
                    </td>
                  </tr>
                ) : (
                  balances.map((balance) => {
                    const empGender = balance.employee?.gender;
                    return (
                      <tr key={balance.id} data-testid="lbl-row" data-employee-id={balance.employeeId} data-gender={empGender ?? ''} className="hover:bg-surface-page/50 transition-colors">
                        <td className="px-5 py-3.5 sticky start-0 bg-surface-card hover:bg-surface-page/50 z-10">
                          <div>
                            <p className="font-semibold text-text-heading text-sm">{balance.employee?.fullName}</p>
                            <p className="text-xs text-text-muted">{balance.employee?.employeeCode}</p>
                            {empGender && (
                              <span className="text-[10px] text-text-muted capitalize">{empGender.toLowerCase()}</span>
                            )}
                          </div>
                        </td>
                        <td className="px-5 py-3.5 text-text-body text-sm">
                          {balance.employee?.department?.name || tc('notAvailable')}
                        </td>

                        {activeLeaveTypes.map((type, idx) => {
                          const color = getColor(idx);
                          const allowed = genderAllowed(type.genderRestriction, empGender);

                          if (!allowed) {
                            return (
                              <td key={type.id} data-testid="lbl-cell" data-leave-type={type.label} data-applicable="false" className="px-5 py-3.5 text-center">
                                <span className="text-text-muted text-lg font-light select-none">—</span>
                              </td>
                            );
                          }

                          const ltb = balance.leaveTypeBalances?.find(b => b.leaveTypeKey === type.label);
                          let allocated = type.defaultDays || 0;
                          let used = 0;
                          let carriedOver = 0;
                          let remaining = allocated;

                          if (ltb) {
                            allocated = ltb.allocated;
                            used = ltb.used;
                            carriedOver = ltb.carriedOver;
                            remaining = ltb.remaining;
                          } else if (type.label.toLowerCase().includes('annual')) {
                            allocated = balance.annualLeave;
                            used = balance.usedAnnual;
                            carriedOver = balance.carriedOver;
                            remaining = balance.remainingAnnual ?? (allocated + carriedOver - used);
                          } else if (type.label.toLowerCase().includes('sick')) {
                            allocated = balance.sickLeave;
                            used = balance.usedSick;
                            remaining = balance.remainingSick ?? (allocated - used);
                          }

                          const isLow = remaining <= 2;
                          return (
                            <td
                              key={type.id}
                              data-testid="lbl-cell"
                              data-leave-type={type.label}
                              data-applicable="true"
                              data-remaining={remaining}
                              data-total={allocated + carriedOver}
                              data-carried={carriedOver}
                              className="px-5 py-3.5 text-center"
                            >
                              <div className={`inline-flex flex-col items-center px-3 py-1.5 rounded-[--radius-card] ${color.badge}`}>
                                <span className={`text-base font-bold ${isLow ? color.low : color.value}`}>
                                  {remaining}
                                </span>
                                <span className="text-[10px] text-text-muted">/ {allocated + carriedOver}</span>
                              </div>
                              {carriedOver > 0 && (
                                <span className="text-[10px] text-status-success block mt-0.5">{t('carriedSuffix', { count: carriedOver })}</span>
                              )}
                            </td>
                          );
                        })}

                        <td className="px-5 py-3.5 text-center">
                          <button
                            data-testid="lbl-edit"
                            onClick={() => handleEditBalance(balance)}
                            className="p-1.5 hover:bg-brand-primary/10 rounded-[--radius-button] transition-colors text-brand-primary inline-flex items-center justify-center border border-transparent hover:border-brand-primary/20"
                            title={t('editBalancesTitle')}
                          >
                            <Edit size={16} />
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Edit Modal */}
      {showEditModal && editBalance && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4 backdrop-blur-xs animate-fadeIn">
          <div data-testid="lbl-modal" className="bg-surface-overlay rounded-[--radius-card] shadow-xl max-w-lg w-full overflow-hidden border border-surface-border">
            <div className="p-6 border-b border-surface-border-light bg-surface-page/50">
              <h3 className="text-xl font-bold text-text-heading">{t('updateModalTitle')}</h3>
              <p className="text-text-muted text-sm mt-1">
                {t('employeeColon', { name: editBalance.employee?.fullName || '' })}
              </p>
            </div>
            <div className="p-6 space-y-4 max-h-[60vh] overflow-y-auto pe-2">
              {activeLeaveTypes
                .filter(type => genderAllowed(type.genderRestriction, editBalance.employee?.gender))
                .map((type, idx) => {
                  const color = getColor(idx);
                  return (
                    <div key={type.id} className={`p-4 border rounded-[--radius-card] space-y-3 ${color.badge}`}>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className={`w-2.5 h-2.5 rounded-full ${color.dot}`} />
                          <p className="font-bold text-text-heading text-sm">{type.label}</p>
                        </div>
                        <span className="text-xs text-text-muted font-normal">{t('yearLabel', { year: selectedYear })}</span>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs font-semibold text-text-muted mb-1">{t('allocatedDaysLabel')}</label>
                          <input
                            data-testid="lbl-modal-allocated"
                            data-leave-type={type.label}
                            type="number"
                            value={editTypeBalances[type.label]?.allocated ?? 0}
                            onChange={(e) => setEditTypeBalances(prev => ({
                              ...prev,
                              [type.label]: { ...prev[type.label], allocated: Number(e.target.value) }
                            }))}
                            min={0}
                            className="w-full px-3 py-2 border border-surface-border rounded-[--radius-input] text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary/20 bg-surface-card text-text-body"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-semibold text-text-muted mb-1">{t('carriedOverDaysLabel')}</label>
                          <input
                            data-testid="lbl-modal-carried"
                            data-leave-type={type.label}
                            type="number"
                            value={editTypeBalances[type.label]?.carriedOver ?? 0}
                            onChange={(e) => setEditTypeBalances(prev => ({
                              ...prev,
                              [type.label]: { ...prev[type.label], carriedOver: Number(e.target.value) }
                            }))}
                            min={0}
                            className="w-full px-3 py-2 border border-surface-border rounded-[--radius-input] text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary/20 bg-surface-card text-text-body"
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
            </div>
            <div className="flex gap-3 p-6 border-t border-surface-border bg-surface-page/50">
              <button
                data-testid="lbl-modal-save"
                onClick={handleSaveEdit}
                className="flex-1 px-5 py-2.5 bg-brand-primary text-text-on-brand rounded-[--radius-button] font-semibold hover:bg-brand-primary-dark transition-colors shadow-sm text-sm"
              >
                {t('saveChanges')}
              </button>
              <button
                data-testid="lbl-modal-cancel"
                onClick={() => setShowEditModal(false)}
                className="px-5 py-2.5 border border-surface-border text-text-body rounded-[--radius-button] hover:bg-surface-page transition-colors bg-surface-card text-sm"
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

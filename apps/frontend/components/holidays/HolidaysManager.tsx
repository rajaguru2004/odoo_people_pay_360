'use client';

import { useMemo, useState } from 'react';
import {
  CalendarDays,
  Plus,
  Pencil,
  Trash2,
  Repeat,
  Copy,
  Building2,
  Globe,
} from 'lucide-react';
import { motion } from 'framer-motion';

import { usePermission } from '@/hooks/usePermission';
import { useBranches } from '@/hooks/useBranches';
import {
  useHolidays,
  useDeleteHoliday,
  useCopyHolidayYear,
} from '@/hooks/useHolidays';
import { Holiday } from '@/types/holiday';
import HolidayFormModal from '@/components/holidays/HolidayFormModal';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * Company-wide + per-branch holidays manager. Rendered as a section of the
 * Settings page (Settings → Holidays).
 */
export default function HolidaysManager() {
  const { isAdmin, isHRManager, user } = usePermission();
  const canManage = isAdmin() || isHRManager();

  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState<number>(currentYear);
  const [branchFilter, setBranchFilter] = useState<string>(''); // '' = all scopes

  const { data: branchData } = useBranches(canManage);
  const branches = useMemo(() => {
    const fromApi = (branchData?.data ?? []).map((b) => ({
      id: b.id,
      code: b.code,
      name: b.name,
    }));
    if (fromApi.length) return fromApi;
    // Scoped HR without global list access: fall back to their granted set.
    return (user?.accessibleBranches ?? []).map((b: any) => ({
      id: b.id,
      code: b.code,
      name: b.name,
    }));
  }, [branchData, user]);

  const { data, isLoading } = useHolidays({
    year,
    branchId: branchFilter || undefined,
  });
  const holidays: Holiday[] = data?.data ?? [];

  const deleteHoliday = useDeleteHoliday();
  const copyYear = useCopyHolidayYear();

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Holiday | null>(null);

  const years = useMemo(
    () => [currentYear - 1, currentYear, currentYear + 1, currentYear + 2],
    [currentYear],
  );

  const openAdd = () => {
    setEditing(null);
    setModalOpen(true);
  };
  const openEdit = (h: Holiday) => {
    setEditing(h);
    setModalOpen(true);
  };

  const handleDelete = async (h: Holiday) => {
    if (!window.confirm(`Delete holiday "${h.name}" on ${formatDate(h.date)}?`))
      return;
    try {
      await deleteHoliday.mutateAsync(h.id);
    } catch (err: any) {
      alert(err?.response?.data?.message || 'Failed to delete holiday');
    }
  };

  const handleCopyNextYear = async () => {
    const toYear = year + 1;
    if (
      !window.confirm(
        `Copy ${year}'s holidays into ${toYear}? Existing dates in ${toYear} are skipped.`,
      )
    )
      return;
    try {
      const res = await copyYear.mutateAsync({
        fromYear: year,
        toYear,
        branchId: branchFilter || undefined,
      });
      const r = res?.data;
      alert(
        `Copied ${r?.created ?? 0} holiday(s) into ${toYear}` +
          (r?.skipped ? ` (${r.skipped} already existed)` : ''),
      );
      setYear(toYear);
    } catch (err: any) {
      alert(err?.response?.data?.message || 'Failed to copy holidays');
    }
  };

  const stats = useMemo(
    () => ({
      total: holidays.length,
      recurring: holidays.filter((h) => h.isRecurring).length,
      companyWide: holidays.filter((h) => !h.branchId).length,
    }),
    [holidays],
  );

  return (
    <>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-text-heading mb-1 flex items-center gap-2.5">
              <CalendarDays className="text-brand-primary" size={22} />
              Holidays
            </h2>
            <p className="text-sm text-text-muted">
              Company-wide and per-branch holidays. Drives attendance, leave and
              payroll work-day calculations.
            </p>
          </div>
          {canManage && (
            <div className="flex items-center gap-2">
              <button
                onClick={handleCopyNextYear}
                disabled={copyYear.isPending || holidays.length === 0}
                className="flex items-center gap-2 px-4 py-2.5 border-2 border-surface-border text-text-body rounded-[--radius-button] hover:bg-surface-page transition-all font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                title={`Copy ${year} holidays into ${year + 1}`}
              >
                <Copy size={18} />
                <span className="hidden sm:inline">Copy to {year + 1}</span>
              </button>
              <button
                onClick={openAdd}
                className="flex items-center gap-2 px-5 py-2.5 bg-brand-primary text-text-on-brand rounded-[--radius-button] hover:bg-brand-primary-dark transition-all font-semibold shadow-lg"
              >
                <Plus size={18} />
                Add Holiday
              </button>
            </div>
          )}
        </div>

        {/* Filters + stats */}
        <div className="flex flex-col sm:flex-row sm:items-end gap-4 justify-between">
          <div className="flex items-end gap-3">
            <div className="space-y-1">
              <label className="block text-xs font-semibold text-text-muted uppercase tracking-wide">
                Year
              </label>
              <select
                value={year}
                onChange={(e) => setYear(Number(e.target.value))}
                className="px-4 py-2.5 border-2 border-surface-border rounded-[--radius-input] bg-surface-card text-text-body font-medium focus:outline-none focus:border-brand-primary"
              >
                {years.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </div>
            {branches.length > 0 && (
              <div className="space-y-1">
                <label className="block text-xs font-semibold text-text-muted uppercase tracking-wide">
                  Scope
                </label>
                <select
                  value={branchFilter}
                  onChange={(e) => setBranchFilter(e.target.value)}
                  className="px-4 py-2.5 border-2 border-surface-border rounded-[--radius-input] bg-surface-card text-text-body font-medium focus:outline-none focus:border-brand-primary"
                >
                  <option value="">All branches</option>
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.code} — {b.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div className="flex items-center gap-4 text-sm">
            <span className="text-text-muted">
              <span className="font-bold text-text-heading">{stats.total}</span>{' '}
              total
            </span>
            <span className="text-text-muted">
              <span className="font-bold text-text-heading">
                {stats.recurring}
              </span>{' '}
              recurring
            </span>
            <span className="text-text-muted">
              <span className="font-bold text-text-heading">
                {stats.companyWide}
              </span>{' '}
              company-wide
            </span>
          </div>
        </div>

        {/* Table */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-surface-card rounded-[--radius-card] border-2 border-surface-border overflow-hidden shadow-lg"
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-page border-b-2 border-surface-border text-start">
                  <th className="px-5 py-3 text-start font-semibold text-text-muted">
                    Date
                  </th>
                  <th className="px-5 py-3 text-start font-semibold text-text-muted">
                    Holiday
                  </th>
                  <th className="px-5 py-3 text-start font-semibold text-text-muted">
                    Scope
                  </th>
                  <th className="px-5 py-3 text-start font-semibold text-text-muted">
                    Type
                  </th>
                  {canManage && (
                    <th className="px-5 py-3 text-end font-semibold text-text-muted">
                      Actions
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  [...Array(4)].map((_, i) => (
                    <tr key={i} className="border-b border-surface-border">
                      <td colSpan={canManage ? 5 : 4} className="px-5 py-4">
                        <div className="h-5 bg-slate-100 rounded animate-pulse" />
                      </td>
                    </tr>
                  ))
                ) : holidays.length === 0 ? (
                  <tr>
                    <td
                      colSpan={canManage ? 5 : 4}
                      className="px-5 py-16 text-center"
                    >
                      <div className="w-14 h-14 rounded-full bg-surface-page flex items-center justify-center mx-auto mb-3">
                        <CalendarDays className="text-text-muted" size={26} />
                      </div>
                      <p className="text-base font-semibold text-text-body mb-1">
                        No holidays for {year}
                      </p>
                      <p className="text-sm text-text-muted">
                        Add one, or copy from the previous year.
                      </p>
                    </td>
                  </tr>
                ) : (
                  holidays.map((h) => (
                    <tr
                      key={h.id}
                      className="border-b border-surface-border hover:bg-surface-page/60 transition-colors"
                    >
                      <td className="px-5 py-3.5 font-medium text-text-body whitespace-nowrap">
                        {formatDate(h.date)}
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="font-semibold text-text-heading">
                          {h.name}
                        </div>
                        {h.description && (
                          <div className="text-xs text-text-muted">
                            {h.description}
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-3.5">
                        {h.branchId ? (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-brand-accent/10 text-brand-accent text-xs font-semibold">
                            <Building2 size={12} />
                            {h.branch?.code ?? 'Branch'}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-brand-primary/10 text-brand-primary text-xs font-semibold">
                            <Globe size={12} />
                            All branches
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3.5">
                        {h.isRecurring ? (
                          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-text-body">
                            <Repeat size={13} className="text-brand-primary" />
                            Recurring
                          </span>
                        ) : (
                          <span className="text-xs text-text-muted">One-off</span>
                        )}
                      </td>
                      {canManage && (
                        <td className="px-5 py-3.5">
                          <div className="flex items-center justify-end gap-1">
                            <button
                              onClick={() => openEdit(h)}
                              className="p-2 rounded-[--radius-button] text-text-muted hover:text-brand-primary hover:bg-brand-primary/10 transition-colors"
                              title="Edit"
                            >
                              <Pencil size={16} />
                            </button>
                            <button
                              onClick={() => handleDelete(h)}
                              className="p-2 rounded-[--radius-button] text-text-muted hover:text-status-error hover:bg-status-error/10 transition-colors"
                              title="Delete"
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </motion.div>
      </div>

      <HolidayFormModal
        open={modalOpen}
        mode={editing ? 'edit' : 'create'}
        holiday={editing}
        branches={branches}
        defaultBranchId={branchFilter || undefined}
        defaultYear={year}
        onClose={() => setModalOpen(false)}
      />
    </>
  );
}

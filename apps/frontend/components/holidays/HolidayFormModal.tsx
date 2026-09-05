'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, CalendarDays, CheckCircle2, AlertCircle, Repeat } from 'lucide-react';
import { Holiday } from '@/types/holiday';
import { useCreateHoliday, useUpdateHoliday } from '@/hooks/useHolidays';

interface BranchOption {
  id: string;
  code: string;
  name: string;
}

interface HolidayFormModalProps {
  open: boolean;
  mode: 'create' | 'edit';
  holiday?: Holiday | null;
  branches: BranchOption[];
  /** Pre-selected scope when adding (matches the page's active branch filter). */
  defaultBranchId?: string;
  /** Used to default the date to the filtered year. */
  defaultYear?: number;
  onClose: () => void;
}

const fieldBase =
  'w-full px-4 py-3 border-2 border-surface-border rounded-[--radius-input] font-medium bg-surface-card text-text-body transition-all focus:outline-none focus:border-brand-primary focus:ring-4 focus:ring-brand-primary/20';

export default function HolidayFormModal({
  open,
  mode,
  holiday,
  branches,
  defaultBranchId,
  defaultYear,
  onClose,
}: HolidayFormModalProps) {
  const createHoliday = useCreateHoliday();
  const updateHoliday = useUpdateHoliday();
  const saving = createHoliday.isPending || updateHoliday.isPending;

  const [name, setName] = useState('');
  const [date, setDate] = useState('');
  const [branchId, setBranchId] = useState<string>(''); // '' = all branches
  const [isRecurring, setIsRecurring] = useState(false);
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // (Re)seed the form whenever it opens or the target holiday changes.
  useEffect(() => {
    if (!open) return;
    setError(null);
    if (mode === 'edit' && holiday) {
      setName(holiday.name);
      setDate(holiday.date ? holiday.date.slice(0, 10) : '');
      setBranchId(holiday.branchId ?? '');
      setIsRecurring(holiday.isRecurring);
      setDescription(holiday.description ?? '');
    } else {
      setName('');
      setDate(defaultYear ? `${defaultYear}-01-01` : '');
      setBranchId(defaultBranchId ?? '');
      setIsRecurring(false);
      setDescription('');
    }
  }, [open, mode, holiday, defaultBranchId, defaultYear]);

  if (!open || !mounted) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) return setError('Holiday name is required');
    if (!date) return setError('Date is required');

    const payload = {
      name: name.trim(),
      date,
      year: Number(date.slice(0, 4)),
      isRecurring,
      branchId: branchId || null,
      description: description.trim() || null,
    };

    try {
      if (mode === 'create') {
        await createHoliday.mutateAsync(payload);
      } else if (holiday) {
        await updateHoliday.mutateAsync({ id: holiday.id, data: payload });
      }
      onClose();
    } catch (err: any) {
      setError(
        err?.response?.data?.message || err?.message || 'Failed to save holiday',
      );
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative w-full max-w-lg bg-surface-card rounded-[--radius-card] border-2 border-surface-border shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b-2 border-surface-border bg-surface-page">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-[--radius-card] bg-brand-primary text-text-on-brand flex items-center justify-center shadow-lg">
              <CalendarDays size={20} />
            </div>
            <h2 className="text-lg font-bold text-text-heading">
              {mode === 'create' ? 'Add Holiday' : 'Edit Holiday'}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-[--radius-button] hover:bg-surface-card transition-colors text-text-muted"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit}>
          <div className="p-6 space-y-5">
            {error && (
              <div className="flex items-center gap-2 p-3 bg-status-error-bg/40 border border-status-error/40 rounded-[--radius-card] text-status-error text-sm font-medium">
                <AlertCircle size={16} />
                <span>{error}</span>
              </div>
            )}

            <div className="space-y-2">
              <label className="block text-sm font-semibold text-text-body">
                Name <span className="text-status-error">*</span>
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. National Day"
                className={fieldBase}
                autoFocus
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="block text-sm font-semibold text-text-body">
                  Date <span className="text-status-error">*</span>
                </label>
                <input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className={fieldBase}
                />
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-semibold text-text-body">
                  Applies to
                </label>
                <select
                  value={branchId}
                  onChange={(e) => setBranchId(e.target.value)}
                  className={fieldBase}
                >
                  <option value="">All branches (company-wide)</option>
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.code} — {b.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-semibold text-text-body">
                Notes
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                placeholder="Optional"
                className={`${fieldBase} resize-none`}
              />
            </div>

            <label className="flex items-center gap-3 p-3 bg-surface-page rounded-[--radius-card] border-2 border-surface-border cursor-pointer">
              <input
                type="checkbox"
                checked={isRecurring}
                onChange={(e) => setIsRecurring(e.target.checked)}
                className="w-5 h-5 rounded accent-brand-primary cursor-pointer"
              />
              <div className="flex items-center gap-2">
                <Repeat size={15} className="text-brand-primary" />
                <div>
                  <span className="text-sm font-semibold text-text-body">
                    Recurring
                  </span>
                  <p className="text-xs text-text-muted">
                    Rolls forward each year via &ldquo;Copy to next year&rdquo;.
                  </p>
                </div>
              </div>
            </label>
          </div>

          {/* Footer */}
          <div className="px-6 py-4 bg-surface-page border-t-2 border-surface-border flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-5 py-2.5 border-2 border-surface-border text-text-body rounded-[--radius-button] hover:bg-surface-card transition-all font-semibold"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex items-center gap-2 px-6 py-2.5 bg-brand-primary text-text-on-brand rounded-[--radius-button] hover:bg-brand-primary-dark transition-all font-semibold shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? (
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <CheckCircle2 size={18} />
              )}
              <span>{mode === 'create' ? 'Add Holiday' : 'Save Changes'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}

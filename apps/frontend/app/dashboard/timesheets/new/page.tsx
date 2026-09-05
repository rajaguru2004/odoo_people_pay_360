'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { Plus, Loader2 } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import PageActionRow from '@/components/common/PageActionRow';
import { usePageHeader } from '@/hooks/usePageHeader';
import timesheetService from '@/services/timesheetService';

export default function NewTimesheetPage() {
  const router = useRouter();

  // The one heading for this route, rendered by TopHeader.
  usePageHeader('Log Time', 'Record hours worked');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    workDate: new Date().toISOString().split('T')[0],
    hoursWorked: '',
    description: '',
  });

  const set = (field: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm((prev) => ({ ...prev, [field]: e.target.value }));

  const handleSubmit = async (e: React.FormEvent, submitAfter = false) => {
    e.preventDefault();
    setError('');
    const hours = parseFloat(form.hoursWorked);
    if (!form.workDate) { setError('Work date is required'); return; }
    if (!hours || hours < 0.5 || hours > 24) { setError('Hours must be between 0.5 and 24'); return; }
    setLoading(true);
    try {
      const res = await timesheetService.create({
        workDate: form.workDate,
        hoursWorked: hours,
        description: form.description || undefined,
      });
      if (submitAfter) {
        await timesheetService.submit(res.data.id);
      }
      router.push('/dashboard/timesheets');
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || 'Failed to create timesheet');
    } finally {
      setLoading(false);
    }
  };

  const inputClass = 'w-full rounded-[--radius-input] border border-surface-border bg-surface-card px-4 py-3 text-sm text-text-body placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary transition-all';

  return (
    <ProtectedRoute requiredPermission="CREATE_TIMESHEET">
      <div className="space-y-6" data-testid="ess-timesheet-new">
        <div className="max-w-lg mx-auto">
          {/* Back button only — the title/subtitle live in the sticky TopHeader,
              declared via usePageHeader above. */}
          <div className="mb-8">
            <PageActionRow onBack={() => router.back()} />
          </div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-surface-card border border-surface-border rounded-[--radius-card] p-8 shadow-sm"
          >
            {error && (
              <div className="mb-5 rounded-[--radius-input] bg-status-error-bg/40 border border-status-error/20 px-4 py-3 text-sm text-status-error">
                {error}
              </div>
            )}

            <div className="space-y-5">
              <div>
                <label className="block text-sm font-semibold text-text-body mb-1.5">Work Date</label>
                <input type="date" value={form.workDate} onChange={set('workDate')} className={inputClass} />
              </div>

              <div>
                <label className="block text-sm font-semibold text-text-body mb-1.5">Hours Worked <span className="text-status-error">*</span></label>
                <input
                  type="number"
                  min="0.5"
                  max="24"
                  step="0.5"
                  placeholder="e.g. 8"
                  value={form.hoursWorked}
                  onChange={set('hoursWorked')}
                  className={inputClass}
                />
                <p className="text-xs text-text-muted mt-1 font-semibold">Min: 0.5, Max: 24</p>
              </div>

              <div>
                <label className="block text-sm font-semibold text-text-body mb-1.5">Description</label>
                <textarea
                  rows={4}
                  placeholder="What did you work on?"
                  value={form.description}
                  onChange={set('description')}
                  className={`${inputClass} resize-none`}
                />
              </div>

              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => router.back()} className="flex-1 rounded-[--radius-button] border border-surface-border text-text-body hover:bg-surface-page py-3 text-sm font-semibold transition-all cursor-pointer">
                  Cancel
                </button>
                <motion.button
                  whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
                  onClick={(e) => handleSubmit(e, false)}
                  disabled={loading}
                  className="flex-1 border-2 border-brand-primary text-brand-primary hover:bg-brand-primary hover:text-text-on-brand rounded-[--radius-button] py-3 text-sm font-bold transition-all disabled:opacity-50 cursor-pointer"
                >
                  Save Draft
                </motion.button>
                <motion.button
                  whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
                  onClick={(e) => handleSubmit(e, true)}
                  disabled={loading}
                  className="flex-1 flex items-center justify-center gap-2 rounded-[--radius-button] bg-brand-primary hover:bg-brand-primary-dark py-3 text-sm font-bold text-text-on-brand transition-all disabled:opacity-50 shadow-md cursor-pointer"
                >
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  {loading ? 'Saving...' : 'Submit'}
                </motion.button>
              </div>
            </div>
          </motion.div>
        </div>
      </div>
    </ProtectedRoute>
  );
}

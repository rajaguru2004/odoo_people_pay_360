'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, UserCheck, UserX, Save } from 'lucide-react';
import supervisorService, {
  SupervisorInfo,
} from '@/services/supervisorService';
import employeeService from '@/services/employeeService';

interface Props {
  employeeId: string;
  canEdit?: boolean;
}

interface Option {
  id: string;
  fullName: string;
  employeeCode?: string;
}

export default function SupervisorSection({ employeeId, canEdit }: Props) {
  const [current, setCurrent] = useState<SupervisorInfo | null>(null);
  const [options, setOptions] = useState<Option[]>([]);
  const [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await supervisorService.getOf(employeeId);
      setCurrent(res.data ?? null);
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Failed to load supervisor');
    } finally {
      setLoading(false);
    }
  }, [employeeId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!canEdit) return;
    employeeService
      .getDirectory()
      .then((res) =>
        setOptions(
          (res.data || [])
            .filter((e: any) => e.id !== employeeId)
            .map((e: any) => ({
              id: e.id,
              fullName: e.fullName,
              employeeCode: e.employeeCode,
            })),
        ),
      )
      .catch(() => undefined);
  }, [canEdit, employeeId]);

  const handleAssign = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await supervisorService.assign(employeeId, selected);
      toast.success('Supervisor assigned');
      setSelected('');
      await load();
    } catch (e: any) {
      toast.error(
        e?.response?.data?.message || e?.message || 'Failed to assign supervisor',
      );
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    setSaving(true);
    try {
      await supervisorService.remove(employeeId);
      toast.success('Supervisor removed');
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Failed to remove supervisor');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-slate-500">
        <Loader2 className="h-5 w-5 animate-spin" /> Loading…
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-primary/10 text-brand-primary">
          <UserCheck className="h-5 w-5" />
        </div>
        <div>
          <h3 className="text-base font-semibold text-slate-900">Supervisor</h3>
          <p className="text-sm text-slate-500">
            Approval responsibility only — independent of department management,
            grants no admin permissions.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
          Current supervisor
        </p>
        {current ? (
          <div className="mt-2 flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-slate-800">
                {current.fullName}
              </p>
              <p className="text-xs text-slate-500">
                {current.position} · {current.employeeCode}
              </p>
            </div>
            {canEdit && (
              <button
                type="button"
                onClick={handleRemove}
                disabled={saving}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-red-200 px-3 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                <UserX size={14} /> Remove
              </button>
            )}
          </div>
        ) : (
          <p className="mt-2 text-sm italic text-slate-400">
            No supervisor assigned.
          </p>
        )}
      </div>

      {canEdit && (
        <div className="rounded-xl border border-slate-200 p-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
            {current ? 'Reassign supervisor' : 'Assign supervisor'}
          </p>
          <div className="flex items-center gap-2">
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              className="h-10 flex-1 rounded-lg border border-slate-200 px-3 text-sm focus:border-brand-primary focus:outline-none focus:ring-2 focus:ring-brand-primary/30"
            >
              <option value="">Select an employee…</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.fullName}
                  {o.employeeCode ? ` (${o.employeeCode})` : ''}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleAssign}
              disabled={saving || !selected}
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand-primary px-4 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

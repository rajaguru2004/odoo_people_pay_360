'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Loader2,
  Plus,
  Pencil,
  Trash2,
  X,
  Search,
  UserCheck,
} from 'lucide-react';
import { toast } from 'sonner';
import supervisorService, {
  SupervisorTeam,
} from '@/services/supervisorService';
import employeeService from '@/services/employeeService';
import PageActionRow from '@/components/common/PageActionRow';
import { usePageHeader } from '@/hooks/usePageHeader';

interface Directory {
  id: string;
  fullName: string;
  employeeCode?: string;
  position?: string;
}

interface FormState {
  id?: string;
  name: string;
  description: string;
  supervisorId: string;
  memberIds: string[];
}

const EMPTY: FormState = {
  name: '',
  description: '',
  supervisorId: '',
  memberIds: [],
};

export default function SupervisorTeamsPage() {
  // The one heading for this route, rendered by TopHeader.
  usePageHeader(
    'Teams',
    'Group employees under a supervisor for leave & overtime approvals',
  );

  const [teams, setTeams] = useState<SupervisorTeam[]>([]);
  const [directory, setDirectory] = useState<Directory[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [memberSearch, setMemberSearch] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await supervisorService.listTeams();
      setTeams(Array.isArray(res.data) ? res.data : []);
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Failed to load teams');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    employeeService
      .getDirectory()
      .then((res) => setDirectory(Array.isArray(res.data) ? (res.data as any) : []))
      .catch(() => undefined);
  }, [load]);

  const openCreate = () => {
    setForm(EMPTY);
    setMemberSearch('');
    setModalOpen(true);
  };

  const openEdit = (t: SupervisorTeam) => {
    setForm({
      id: t.id,
      name: t.name,
      description: t.description || '',
      supervisorId: t.teamLeadId || '',
      memberIds: t.members.map((m) => m.employeeId),
    });
    setMemberSearch('');
    setModalOpen(true);
  };

  const save = async () => {
    if (!form.name.trim()) return toast.warning('Team name is required');
    if (!form.supervisorId) return toast.warning('Select a supervisor');
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        supervisorId: form.supervisorId,
        memberIds: form.memberIds,
      };
      if (form.id) {
        await supervisorService.updateTeam(form.id, payload);
        toast.success('Team updated');
      } else {
        await supervisorService.createTeam(payload);
        toast.success('Team created');
      }
      setModalOpen(false);
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.message || e?.message || 'Failed to save team');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (t: SupervisorTeam) => {
    if (
      !confirm(
        `Delete team "${t.name}"? Members will be detached from this supervisor.`,
      )
    )
      return;
    try {
      await supervisorService.deleteTeam(t.id);
      toast.success('Team deleted');
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Failed to delete team');
    }
  };

  const toggleMember = (id: string) =>
    setForm((f) => ({
      ...f,
      memberIds: f.memberIds.includes(id)
        ? f.memberIds.filter((m) => m !== id)
        : [...f.memberIds, id],
    }));

  const memberOptions = useMemo(
    () =>
      directory
        .filter((d) => d.id !== form.supervisorId)
        .filter((d) =>
          memberSearch
            ? d.fullName.toLowerCase().includes(memberSearch.toLowerCase()) ||
              (d.employeeCode || '')
                .toLowerCase()
                .includes(memberSearch.toLowerCase())
            : true,
        ),
    [directory, memberSearch, form.supervisorId],
  );

  return (
    <div className="p-6">
      {/* Heading lives in TopHeader via usePageHeader — only the action stays here. */}
      <div className="mb-6">
        <PageActionRow
          action={
            <button
              data-testid="steam-create"
              onClick={openCreate}
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand-primary px-4 text-sm font-medium text-white hover:opacity-90"
            >
              <Plus className="h-4 w-4" /> Create Team
            </button>
          }
        />
      </div>

      {loading ? (
        <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white p-8 text-slate-500 shadow-sm">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading…
        </div>
      ) : teams.length === 0 ? (
        <div data-testid="steam-empty" className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-slate-400 shadow-sm">
          No teams yet. Click “Create Team” to add one.
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {teams.map((t) => (
            <div
              key={t.id}
              data-testid={`steam-row-${t.id}`}
              className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold text-slate-900">
                    {t.name}
                  </h3>
                  {t.description && (
                    <p className="text-xs text-slate-500">{t.description}</p>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <button
                    data-testid={`steam-edit-${t.id}`}
                    onClick={() => openEdit(t)}
                    className="rounded-lg p-2 text-slate-400 hover:bg-slate-50 hover:text-brand-primary"
                    title="Edit"
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    data-testid={`steam-delete-${t.id}`}
                    onClick={() => remove(t)}
                    className="rounded-lg p-2 text-slate-400 hover:bg-red-50 hover:text-red-600"
                    title="Delete"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>

              <div className="mt-3 flex items-center gap-2 rounded-lg bg-brand-primary/5 p-2.5">
                <UserCheck className="h-4 w-4 text-brand-primary" />
                <span className="text-xs text-slate-500">Supervisor:</span>
                <span className="text-sm font-medium text-slate-800">
                  {t.teamLead?.fullName || '—'}
                </span>
              </div>

              <div className="mt-3">
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">
                  {t.members.length} member{t.members.length === 1 ? '' : 's'}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {t.members.slice(0, 8).map((m) => (
                    <span
                      key={m.id}
                      className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700"
                    >
                      {m.employee.fullName}
                    </span>
                  ))}
                  {t.members.length > 8 && (
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-500">
                      +{t.members.length - 8}
                    </span>
                  )}
                  {t.members.length === 0 && (
                    <span className="text-xs italic text-slate-400">
                      No members
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-900">
                {form.id ? 'Edit Team' : 'Create Team'}
              </h2>
              <button
                onClick={() => setModalOpen(false)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"
              >
                <X size={18} />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">
                  Team name
                </label>
                <input
                  data-testid="steam-form-name"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. QA Reviewers"
                  className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm focus:border-brand-primary focus:outline-none focus:ring-2 focus:ring-brand-primary/30"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">
                  Description <span className="text-slate-400">(optional)</span>
                </label>
                <input
                  value={form.description}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, description: e.target.value }))
                  }
                  className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm focus:border-brand-primary focus:outline-none focus:ring-2 focus:ring-brand-primary/30"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">
                  Supervisor
                </label>
                <select
                  data-testid="steam-form-supervisor"
                  value={form.supervisorId}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      supervisorId: e.target.value,
                      memberIds: f.memberIds.filter((m) => m !== e.target.value),
                    }))
                  }
                  className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm focus:border-brand-primary focus:outline-none focus:ring-2 focus:ring-brand-primary/30"
                >
                  <option value="">Select a supervisor…</option>
                  {directory.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.fullName}
                      {d.employeeCode ? ` (${d.employeeCode})` : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">
                  Members{' '}
                  <span className="text-slate-400">
                    ({form.memberIds.length} selected)
                  </span>
                </label>
                <div className="relative mb-2">
                  <Search
                    size={15}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                  />
                  <input
                    value={memberSearch}
                    onChange={(e) => setMemberSearch(e.target.value)}
                    placeholder="Search employees…"
                    className="h-9 w-full rounded-lg border border-slate-200 pl-9 pr-3 text-sm focus:border-brand-primary focus:outline-none focus:ring-2 focus:ring-brand-primary/30"
                  />
                </div>
                <div className="max-h-52 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
                  {memberOptions.length === 0 ? (
                    <p className="p-2 text-sm italic text-slate-400">
                      No employees match.
                    </p>
                  ) : (
                    memberOptions.map((d) => (
                      <label
                        key={d.id}
                        className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-50"
                      >
                        <input
                          type="checkbox"
                          checked={form.memberIds.includes(d.id)}
                          onChange={() => toggleMember(d.id)}
                          className="h-4 w-4 accent-brand-primary"
                        />
                        <span className="text-sm text-slate-700">
                          {d.fullName}
                          {d.employeeCode ? (
                            <span className="text-slate-400">
                              {' '}
                              · {d.employeeCode}
                            </span>
                          ) : null}
                        </span>
                      </label>
                    ))
                  )}
                </div>
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={() => setModalOpen(false)}
                className="h-10 rounded-lg border border-slate-200 px-4 text-sm font-medium text-slate-600 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                data-testid="steam-form-submit"
                onClick={save}
                disabled={saving}
                className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand-primary px-5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {form.id ? 'Save changes' : 'Create team'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

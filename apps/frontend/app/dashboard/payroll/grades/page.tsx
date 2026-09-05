'use client';

import { useEffect, useState } from 'react';
import { Layers, Loader2, Plus, Users } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { FeaturePending } from '@/components/payroll/FeatureGate';
import PageActionRow from '@/components/common/PageActionRow';
import { usePayrollFeatures } from '@/hooks/usePayrollFeatures';
import { usePageHeader } from '@/hooks/usePageHeader';
import { gradeService, type Grade } from '@/services/payrollExtensionsService';
import employeeService from '@/services/employeeService';
import { formatCurrency } from '@/utils/formatters';
import { apiErrorMessage } from '@/utils/apiError';
import { toast } from '@/lib/toast';

/**
 * Pay bands.
 *
 * A NEW axis, not a rename of `employmentType` — that is a contract-type label
 * that drives overtime policy, and repurposing it would change overtime for
 * everybody. The template a grade carries pre-fills a salary structure; it is
 * never itself a payroll input.
 */
function GradesContent() {
  const features = usePayrollFeatures();

  // The one heading for this route, rendered by TopHeader.
  usePageHeader('Grades', 'Pay bands, and the salary template each one suggests on hire.');

  const [rows, setRows] = useState<Grade[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ code: '', name: '', level: 1, minSalary: '', maxSalary: '' });
  const [busy, setBusy] = useState(false);
  const [assigning, setAssigning] = useState<Grade | null>(null);
  const [employees, setEmployees] = useState<any[]>([]);
  const [assignTo, setAssignTo] = useState('');
  const [editing, setEditing] = useState<Grade | null>(null);
  const [components, setComponents] = useState<Array<Record<string, string>>>([]);

  const load = async () => {
    setLoading(true);
    try {
      const res = await gradeService.list(true);
      setRows(res.data ?? []);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not load grades'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!features.grade) {
      setLoading(false);
      return;
    }
    void load();
    employeeService
      .getAll({ limit: 500 } as never)
      .then((r: any) => setEmployees(r?.data?.data ?? r?.data ?? []))
      .catch(() => setEmployees([]));
  }, [features.grade]);

  const submit = async () => {
    setBusy(true);
    try {
      await gradeService.create({
        code: form.code,
        name: form.name,
        level: Number(form.level),
        minSalary: form.minSalary ? Number(form.minSalary) : undefined,
        maxSalary: form.maxSalary ? Number(form.maxSalary) : undefined,
      });
      setCreating(false);
      setForm({ code: '', name: '', level: 1, minSalary: '', maxSalary: '' });
      await load();
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not create the grade'));
    } finally {
      setBusy(false);
    }
  };

  // A flag that has not been READ yet is not a flag that is off. Every switch in
  // `brandingStore` initialises to false, so without this the screen states
  // "switched off" as a fact over a feature the admin has just turned on.
  if (!features.loaded) return <FeaturePending />;

  if (!features.grade) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-8 text-center">
        <Layers size={28} className="mx-auto mb-3 text-slate-300" />
        <h2 className="text-base font-semibold text-slate-800">Grades are switched off</h2>
        <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
          Turn them on under Settings → Payroll → Payroll extensions. Employment
          type is unaffected either way — grade is a separate axis, not a rename
          of it.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageActionRow
        action={
          <button
            type="button"
            onClick={() => setCreating(true)}
            data-testid="grade-new"
            className="inline-flex items-center gap-2 rounded-lg bg-brand-primary px-4 py-2 text-sm font-medium text-white"
          >
            <Plus size={15} /> New grade
          </button>
        }
      />

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        {loading ? (
          <div className="p-8 text-center text-sm text-slate-500">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">No grades yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Code</th>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3 text-right">Level</th>
                <th className="px-4 py-3">Band</th>
                <th className="px-4 py-3 text-right">People</th>
                <th className="px-4 py-3">State</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((g) => (
                <tr key={g.id} data-testid="grade-row">
                  <td className="px-4 py-2 font-mono text-slate-800">{g.code}</td>
                  <td className="px-4 py-2 text-slate-700">{g.name}</td>
                  <td className="px-4 py-2 text-right text-slate-600">{g.level}</td>
                  <td className="px-4 py-2 text-slate-600">
                    {g.minSalary || g.maxSalary
                      ? `${g.minSalary ? formatCurrency(Number(g.minSalary)) : '—'} → ${
                          g.maxSalary ? formatCurrency(Number(g.maxSalary)) : '—'
                        }`
                      : 'No band'}
                  </td>
                  <td className="px-4 py-2 text-right text-slate-600">
                    {g._count?.employees ?? 0}
                  </td>
                  <td className="px-4 py-2">
                    {g.isActive ? (
                      <span className="rounded-full bg-emerald-100 px-2 py-1 text-xs text-emerald-700">Active</span>
                    ) : (
                      <span className="rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-500">Retired</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex justify-end gap-1">
                      <button
                        type="button"
                        data-testid="grade-template"
                        onClick={() => {
                          setEditing(g);
                          setComponents(
                            (g.components ?? []).map((c) => ({
                              componentType: c.componentType,
                              valueType: c.valueType,
                              value: String(c.value),
                            })),
                          );
                        }}
                        className="rounded-lg border border-slate-300 px-2 py-1 text-xs text-slate-600"
                      >
                        Template
                      </button>
                      <button
                        type="button"
                        data-testid="grade-assign"
                        onClick={() => { setAssigning(g); setAssignTo(''); }}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2 py-1 text-xs text-slate-600"
                      >
                        <Users size={12} /> Assign
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {creating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
            <h2 className="text-base font-semibold text-slate-800">New grade</h2>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <label className="text-xs font-medium text-slate-600">
                Code
                <input
                  value={form.code}
                  onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
                  data-testid="grade-code"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </label>
              <label className="text-xs font-medium text-slate-600">
                Level
                <input
                  type="number" min={1}
                  value={form.level}
                  onChange={(e) => setForm((f) => ({ ...f, level: Number(e.target.value) }))}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </label>
              <label className="col-span-2 text-xs font-medium text-slate-600">
                Name
                <input
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  data-testid="grade-name"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </label>
              <label className="text-xs font-medium text-slate-600">
                Band from
                <input
                  type="number"
                  value={form.minSalary}
                  onChange={(e) => setForm((f) => ({ ...f, minSalary: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </label>
              <label className="text-xs font-medium text-slate-600">
                Band to
                <input
                  type="number"
                  value={form.maxSalary}
                  onChange={(e) => setForm((f) => ({ ...f, maxSalary: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </label>
            </div>
            <p className="mt-2 text-[11px] text-slate-400">
              An employee whose salary falls outside the band is refused the
              grade, naming both figures.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setCreating(false)} className="rounded-lg px-4 py-2 text-sm text-slate-600">
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={busy || !form.code || !form.name}
                data-testid="grade-create"
                className="inline-flex items-center gap-2 rounded-lg bg-brand-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {busy && <Loader2 size={14} className="animate-spin" />}
                Create
              </button>
            </div>
          </div>
        </div>
      )}
      {assigning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
            <h2 className="text-base font-semibold text-slate-800">
              Put somebody on {assigning.code}
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Refused when their salary sits outside the band, naming both
              figures — the band is the point of a grade.
            </p>
            <select
              value={assignTo}
              data-testid="grade-assign-employee"
              onChange={(e) => setAssignTo(e.target.value)}
              className="mt-4 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="">Choose…</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>{e.fullName} ({e.employeeCode})</option>
              ))}
            </select>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setAssigning(null)} className="rounded-lg px-4 py-2 text-sm text-slate-600">
                Cancel
              </button>
              <button
                type="button"
                disabled={busy || !assignTo}
                data-testid="grade-assign-confirm"
                onClick={async () => {
                  setBusy(true);
                  try {
                    await gradeService.assign(assignTo, assigning.id);
                    setAssigning(null);
                    await load();
                    toast.success('Assigned');
                  } catch (err) {
                    toast.error(apiErrorMessage(err, 'Could not assign the grade'));
                  } finally {
                    setBusy(false);
                  }
                }}
                className="rounded-lg bg-brand-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                Assign
              </button>
            </div>
          </div>
        </div>
      )}

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-xl bg-white p-5 shadow-xl">
            <h2 className="text-base font-semibold text-slate-800">
              {editing.code} salary template
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              A suggestion that pre-fills a new hire&rsquo;s structure. Payroll
              never reads it — the engine only ever reads salary components.
            </p>

            <div className="mt-4 space-y-2">
              {components.map((c, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    value={c.componentType}
                    placeholder="HOUSING"
                    onChange={(e) => setComponents((cs) =>
                      cs.map((x, j) => (j === i ? { ...x, componentType: e.target.value.toUpperCase() } : x)))}
                    className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                  <select
                    value={c.valueType}
                    onChange={(e) => setComponents((cs) =>
                      cs.map((x, j) => (j === i ? { ...x, valueType: e.target.value } : x)))}
                    className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
                  >
                    <option value="FIXED">Fixed</option>
                    <option value="PERCENT_OF_BASIC">% of basic</option>
                  </select>
                  <input
                    type="number"
                    value={c.value}
                    onChange={(e) => setComponents((cs) =>
                      cs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                    className="w-24 rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => setComponents((cs) => cs.filter((_, j) => j !== i))}
                    className="rounded-lg px-2 text-sm text-slate-400"
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type="button"
                data-testid="grade-template-add"
                onClick={() => setComponents((cs) => [...cs, { componentType: '', valueType: 'FIXED', value: '0' }])}
                className="rounded-lg border border-dashed border-slate-300 px-3 py-2 text-xs text-slate-500"
              >
                + Add a component
              </button>
            </div>
            <p className="mt-2 text-[11px] text-slate-400">
              A percentage above 1000 is refused — it is almost always a rate
              entered as basis points, which would multiply the allowance by a
              hundred.
            </p>

            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setEditing(null)} className="rounded-lg px-4 py-2 text-sm text-slate-600">
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                data-testid="grade-template-save"
                onClick={async () => {
                  setBusy(true);
                  try {
                    await gradeService.setComponents(
                      editing.id,
                      components
                        .filter((c) => c.componentType.trim())
                        .map((c) => ({
                          componentType: c.componentType.trim(),
                          valueType: c.valueType,
                          value: Number(c.value) || 0,
                        })),
                    );
                    setEditing(null);
                    await load();
                    toast.success('Template saved');
                  } catch (err) {
                    toast.error(apiErrorMessage(err, 'Could not save the template'));
                  } finally {
                    setBusy(false);
                  }
                }}
                className="rounded-lg bg-brand-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function GradesPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER']}>
      <GradesContent />
    </ProtectedRoute>
  );
}

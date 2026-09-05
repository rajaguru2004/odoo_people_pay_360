'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Loader2,
  GitBranch,
  Plus,
  X,
  ArrowUp,
  ArrowDown,
  Save,
} from 'lucide-react';
import systemSettingsService from '@/services/systemSettingsService';
import approvalWorkflowService, {
  ApproverType,
  ApprovalMode,
  ApprovalKindMeta,
  ApprovalWorkflow,
} from '@/services/approvalWorkflowService';

const APPROVER_TYPES: ApproverType[] = [
  'SUPERVISOR',
  'MANAGER',
  'HR_MANAGER',
  'ADMIN',
];
const LABEL: Record<ApproverType, string> = {
  SUPERVISOR: 'Supervisor',
  MANAGER: 'Dept. Manager',
  HR_MANAGER: 'HR',
  ADMIN: 'Admin',
};
const MODE_LABEL: Record<ApprovalMode, string> = {
  SEQUENTIAL: 'Step by step',
  PARALLEL: 'All at once',
};
const MODE_HINT: Record<ApprovalMode, string> = {
  SEQUENTIAL:
    'Each role is asked in order — the next role only sees the request after the current one accepts.',
  PARALLEL:
    'Every role is asked at the same time, in any order. The request is approved once all of them accept.',
};

const inputCls =
  'w-full h-10 px-3 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/30 transition-all';

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-brand-primary/30 ${checked ? 'bg-brand-primary' : 'bg-slate-300'}`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : 'translate-x-0.5'}`}
      />
    </button>
  );
}

export default function SupervisorHierarchySection() {
  const [enabled, setEnabled] = useState(false);
  // Governable request types come from the backend registry, so a new approvable
  // module appears here without a frontend change.
  const [kinds, setKinds] = useState<ApprovalKindMeta[]>([]);
  const [chains, setChains] = useState<Record<string, ApproverType[]>>({});
  const [modes, setModes] = useState<Record<string, ApprovalMode>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [settingsRes, wfRes, kindsRes] = await Promise.all([
          systemSettingsService.getAll(),
          approvalWorkflowService.list(),
          approvalWorkflowService.kinds(),
        ]);
        const enabledVal =
          settingsRes.data.find((s) => s.key === 'supervisor_approval_enabled')
            ?.value === 'true';
        setEnabled(enabledVal);

        const kindList = kindsRes.data || [];
        setKinds(kindList);

        const next: Record<string, ApproverType[]> = {};
        const nextModes: Record<string, ApprovalMode> = {};
        for (const k of kindList) {
          next[k.type] = [];
          nextModes[k.type] = 'SEQUENTIAL';
        }
        (wfRes.data || [])
          .filter((w: ApprovalWorkflow) => w.isActive)
          .forEach((w: ApprovalWorkflow) => {
            next[w.requestType] = [...w.steps]
              .sort((a, b) => a.stepOrder - b.stepOrder)
              .map((s) => s.approverType);
            nextModes[w.requestType] = w.mode ?? 'SEQUENTIAL';
          });
        setChains(next);
        setModes(nextModes);
      } catch (e: any) {
        toast.error(
          e?.response?.data?.message ||
            e?.message ||
            'Failed to load approval settings',
        );
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const addStep = (type: string, approver: ApproverType) =>
    setChains((c) => ({ ...c, [type]: [...(c[type] ?? []), approver] }));
  const removeStep = (type: string, idx: number) =>
    setChains((c) => ({
      ...c,
      [type]: (c[type] ?? []).filter((_, i) => i !== idx),
    }));
  const move = (type: string, idx: number, dir: -1 | 1) =>
    setChains((c) => {
      const arr = [...(c[type] ?? [])];
      const j = idx + dir;
      if (j < 0 || j >= arr.length) return c;
      [arr[idx], arr[j]] = [arr[j], arr[idx]];
      return { ...c, [type]: arr };
    });

  const handleSave = async () => {
    setSaving(true);
    try {
      await systemSettingsService.update({
        supervisor_approval_enabled: String(enabled),
      });
      for (const kind of kinds) {
        const steps = chains[kind.type] ?? [];
        if (steps.length > 0) {
          await approvalWorkflowService.upsert({
            requestType: kind.type,
            name: `${kind.label} approval chain`,
            mode: modes[kind.type] ?? 'SEQUENTIAL',
            steps: steps.map((approverType) => ({ approverType })),
          });
        }
      }
      toast.success('Approval hierarchy saved successfully!');
    } catch (e: any) {
      toast.error(
        e?.response?.data?.message || e?.message || 'Failed to save',
      );
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-6 text-slate-500">
        <Loader2 className="h-5 w-5 animate-spin" /> Loading…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-primary/10 text-brand-primary">
              <GitBranch className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-slate-900">
                Configurable Approval Hierarchy
              </h3>
              <p className="text-sm text-slate-500">
                Route approvals through an ordered chain (Supervisor → HR →
                Admin, etc.). When off, the legacy single-approver flow applies.
              </p>
            </div>
          </div>
          <Toggle checked={enabled} onChange={setEnabled} />
        </div>

        <div className="space-y-6">
          {kinds.map(({ type, label }) => (
            <div key={type} className="rounded-xl border border-slate-200 p-4">
              <div className="mb-3 flex items-center justify-between">
                <h4 className="text-sm font-semibold text-slate-800">
                  {label} approval chain
                </h4>
                <div className="flex items-center gap-2">
                  <select
                    className={`${inputCls} !h-9 !w-auto`}
                    value={modes[type] ?? 'SEQUENTIAL'}
                    onChange={(e) =>
                      setModes((m) => ({
                        ...m,
                        [type]: e.target.value as ApprovalMode,
                      }))
                    }
                    title="How the steps in this chain are activated"
                  >
                    {(['SEQUENTIAL', 'PARALLEL'] as ApprovalMode[]).map((m) => (
                      <option key={m} value={m}>
                        {MODE_LABEL[m]}
                      </option>
                    ))}
                  </select>
                  <select
                    className={`${inputCls} !h-9 !w-auto`}
                    defaultValue=""
                    onChange={(e) => {
                      if (e.target.value) {
                        addStep(type, e.target.value as ApproverType);
                        e.target.value = '';
                      }
                    }}
                  >
                    <option value="">+ Add step…</option>
                    {APPROVER_TYPES.map((a) => (
                      <option key={a} value={a}>
                        {LABEL[a]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {(chains[type] ?? []).length > 0 && (
                <p className="mb-3 text-xs text-slate-500">
                  {MODE_HINT[modes[type] ?? 'SEQUENTIAL']}
                </p>
              )}

              {(chains[type] ?? []).length === 0 ? (
                <p className="text-sm italic text-slate-400">
                  No steps — this type uses the legacy single-approver flow.
                </p>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  {(chains[type] ?? []).map((step, idx) => (
                    <div key={idx} className="flex items-center gap-1">
                      <span className="inline-flex items-center gap-1 rounded-lg border border-brand-primary/30 bg-brand-primary/5 px-3 py-1.5 text-sm font-medium text-brand-primary">
                        <span className="text-xs text-slate-400">{idx + 1}.</span>
                        {LABEL[step]}
                        <button
                          type="button"
                          onClick={() => move(type, idx, -1)}
                          className="ml-1 text-slate-400 hover:text-slate-700 disabled:opacity-30"
                          disabled={idx === 0}
                          title="Move earlier"
                        >
                          <ArrowUp size={12} />
                        </button>
                        <button
                          type="button"
                          onClick={() => move(type, idx, 1)}
                          className="text-slate-400 hover:text-slate-700 disabled:opacity-30"
                          disabled={idx === (chains[type] ?? []).length - 1}
                          title="Move later"
                        >
                          <ArrowDown size={12} />
                        </button>
                        <button
                          type="button"
                          onClick={() => removeStep(type, idx)}
                          className="text-slate-400 hover:text-red-600"
                          title="Remove"
                        >
                          <X size={12} />
                        </button>
                      </span>
                      {idx < (chains[type] ?? []).length - 1 && (
                        <span className="text-slate-300">
                          {(modes[type] ?? 'SEQUENTIAL') === 'PARALLEL' ? '+' : '→'}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand-primary px-5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Save changes
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        <strong>Note:</strong> <em>Step by step</em> asks one role at a time —
        the request only reaches the next role after the current approver
        accepts. <em>All at once</em> asks every role simultaneously and needs
        all of them to accept. Either way, one rejection closes the request. A{' '}
        <em>Supervisor</em> step routes to each
        employee&apos;s assigned supervisor (set on the employee profile). Steps
        with no eligible approver are skipped automatically so requests never
        dead-end. Supervisor is an approval responsibility only — it grants no
        administrative permissions.
      </div>
    </div>
  );
}

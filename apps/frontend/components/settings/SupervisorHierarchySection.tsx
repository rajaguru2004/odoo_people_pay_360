'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, GitBranch, Users, X } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { EmptyState } from '@/components/common/EmptyState';
import { useDebounce } from '@/hooks/useDebounce';
import { useEmployees } from '@/hooks/useEmployees';
import {
  useAssignSupervisor,
  useSupervisorReports,
  useUnassignSupervisor,
} from '@/hooks/useSupervisors';
import { useApprovalKinds, useApprovalWorkflows, useUpsertApprovalWorkflow } from '@/hooks/useApprovals';
import { apiErrorMessage } from '@/utils/apiError';
import { cn } from '@/utils/cn';
import { fullName } from '@/utils/formatters';
import type { ApprovalMode, ApprovalRequestType, ApproverType } from '@/types/approval';
import { Field, SectionCard, SettingInput, ToggleRow } from './SettingsPrimitives';

/** The master switch the approval engine reads. Opt-in: absent means off. */
export const APPROVAL_MASTER_KEY = 'supervisor_approval_enabled';

const APPROVER_TYPES: ApproverType[] = ['SUPERVISOR', 'MANAGER', 'HR_MANAGER', 'ADMIN'];

const APPROVER_LABEL: Record<ApproverType, string> = {
  SUPERVISOR: 'Supervisor',
  MANAGER: 'Department manager',
  HR_MANAGER: 'HR',
  ADMIN: 'Administrator',
};

const MODE_LABEL: Record<ApprovalMode, string> = {
  SEQUENTIAL: 'One at a time',
  PARALLEL: 'All at once',
};

const MODE_HINT: Record<ApprovalMode, string> = {
  SEQUENTIAL:
    'Each role is asked in turn — the next one only sees the request once the current one accepts.',
  PARALLEL: 'Every role is asked at once, in any order, and all of them have to accept.',
};

/** How many people the supervisor picker offers before it asks you to search. */
const PICKER_LIMIT = 50;

/**
 * Who signs a person's leave and their timesheet.
 *
 * Deliberately separate from the manager on the employee record, which says
 * where somebody sits in the structure. A matrixed engineer reports to a
 * functional head and is supervised by a project lead, and collapsing the two
 * is how a reorganisation silently reroutes every pending approval.
 */
function SupervisorAssignments() {
  const [supervisorId, setSupervisorId] = useState('');
  const [candidateId, setCandidateId] = useState('');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search);

  const people = useEmployees({
    status: 'ACTIVE',
    limit: PICKER_LIMIT,
    search: debouncedSearch || undefined,
    sortBy: 'firstName',
  });

  const reports = useSupervisorReports(supervisorId || undefined);
  const assign = useAssignSupervisor();
  const unassign = useUnassignSupervisor();

  const employees = useMemo(() => people.data?.data ?? [], [people.data]);
  // Two hops: the response envelope, then the `{ count, data }` the route answers with.
  const team = useMemo(() => reports.data?.data ?? [], [reports.data]);
  const teamIds = useMemo(() => new Set(team.map((row) => row.id)), [team]);

  // Somebody already on this supervisor's list, or the supervisor themselves,
  // would be refused by the server. Leaving them in the picker offers a choice
  // whose only outcome is an error toast.
  const candidates = employees.filter(
    (person) => person.id !== supervisorId && !teamIds.has(person.id),
  );

  const supervisor = employees.find((person) => person.id === supervisorId);

  const attach = async () => {
    if (!supervisorId || !candidateId) return;
    try {
      await assign.mutateAsync({ employeeId: candidateId, supervisorId });
      toast.success('Supervisor assigned');
      setCandidateId('');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not assign that supervisor'));
    }
  };

  const detach = async (employeeId: string, name: string) => {
    try {
      await unassign.mutateAsync(employeeId);
      toast.success(`${name} no longer reports to a supervisor`);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not detach that employee'));
    }
  };

  return (
    <SectionCard
      title="Supervisor assignments"
      description="Who signs each person's leave and timesheet — not the same question as who they report to on the org chart"
      icon={Users}
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field
          label="Find a person"
          hint="Filters both pickers. The list shows the first 50 active employees until you narrow it."
        >
          {(id) => (
            <SettingInput
              id={id}
              value={search}
              onChange={setSearch}
              placeholder="Name or employee code"
            />
          )}
        </Field>

        <Field label="Supervisor">
          {(id) => (
            <Select
              id={id}
              value={supervisorId}
              onChange={(event) => {
                setSupervisorId(event.target.value);
                setCandidateId('');
              }}
              placeholder="Pick a supervisor"
            >
              {employees.map((person) => (
                <option key={person.id} value={person.id}>
                  {fullName(person)} · {person.employeeCode}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      {!supervisorId ? (
        <p className="text-sm text-text-muted">
          Pick a supervisor to see who they sign for, and to route more people to them.
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <Field label="Route someone to them" className="flex-1">
              {(id) => (
                <Select
                  id={id}
                  value={candidateId}
                  onChange={(event) => setCandidateId(event.target.value)}
                  placeholder={
                    candidates.length ? 'Pick an employee' : 'Nobody left in this list'
                  }
                >
                  {candidates.map((person) => (
                    <option key={person.id} value={person.id}>
                      {fullName(person)} · {person.employeeCode}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Button
              onClick={attach}
              disabled={!candidateId}
              isLoading={assign.isPending}
              className="shrink-0"
            >
              Assign
            </Button>
          </div>

          <div className="rounded-[var(--radius-card)] border border-surface-border-light">
            <div className="flex items-center justify-between gap-3 border-b border-surface-border-light px-4 py-2.5">
              <h4 className="text-sm font-medium text-text-heading">
                {supervisor ? `${fullName(supervisor)} signs for` : 'Signs for'}
              </h4>
              <Badge>{team.length}</Badge>
            </div>

            {reports.isLoading ? (
              <p className="px-4 py-6 text-center text-sm text-text-muted">Loading…</p>
            ) : team.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-text-muted">
                Nobody yet. Anything they would have approved falls to the next role in the
                chain.
              </p>
            ) : (
              <ul className="divide-y divide-surface-border-light">
                {team.map((person) => (
                  <li key={person.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-text-heading">
                        {person.fullName}
                      </p>
                      <p className="truncate text-xs text-text-muted">
                        {person.employeeCode}
                        {person.department && ` · ${person.department.name}`}
                        {person.position && ` · ${person.position}`}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Detach ${person.fullName}`}
                      disabled={unassign.isPending}
                      onClick={() => detach(person.id, person.fullName)}
                    >
                      <X className="h-4 w-4" aria-hidden />
                      Detach
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </SectionCard>
  );
}

/** One request type's chain of approvers, in order. */
function ChainEditor({
  label,
  steps,
  mode,
  onChangeSteps,
  onChangeMode,
  disabled,
}: {
  label: string;
  steps: ApproverType[];
  mode: ApprovalMode;
  onChangeSteps: (steps: ApproverType[]) => void;
  onChangeMode: (mode: ApprovalMode) => void;
  disabled?: boolean;
}) {
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= steps.length) return;
    const next = [...steps];
    [next[index], next[target]] = [next[target], next[index]];
    onChangeSteps(next);
  };

  return (
    <div className="rounded-[var(--radius-card)] border border-surface-border-light p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h4 className="text-sm font-medium text-text-heading">{label}</h4>
        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor={`mode-${label}`}>
            How {label} steps are activated
          </label>
          <Select
            id={`mode-${label}`}
            value={mode}
            disabled={disabled}
            onChange={(event) => onChangeMode(event.target.value as ApprovalMode)}
            className="!w-auto"
          >
            {(Object.keys(MODE_LABEL) as ApprovalMode[]).map((option) => (
              <option key={option} value={option}>
                {MODE_LABEL[option]}
              </option>
            ))}
          </Select>

          <label className="sr-only" htmlFor={`add-${label}`}>
            Add a step to {label}
          </label>
          <Select
            id={`add-${label}`}
            value=""
            disabled={disabled}
            onChange={(event) => {
              const approver = event.target.value as ApproverType;
              if (approver) onChangeSteps([...steps, approver]);
            }}
            className="!w-auto"
          >
            <option value="">Add a step…</option>
            {APPROVER_TYPES.map((approver) => (
              <option key={approver} value={approver}>
                {APPROVER_LABEL[approver]}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {steps.length === 0 ? (
        <p className="mt-3 text-sm text-text-muted">
          No chain — this type falls back to the plain single-approver rule.
        </p>
      ) : (
        <>
          <p className="mt-2 text-xs text-text-muted">{MODE_HINT[mode]}</p>
          <ol className="mt-3 flex flex-wrap items-center gap-2">
            {steps.map((step, index) => (
              <li key={`${step}-${index}`} className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-[var(--radius-button)] border border-brand-primary/30 bg-status-info-bg px-2.5 py-1.5 text-sm font-medium text-brand-primary">
                  <span className="text-xs text-text-muted">{index + 1}.</span>
                  {APPROVER_LABEL[step]}
                  <button
                    type="button"
                    aria-label={`Move ${APPROVER_LABEL[step]} earlier`}
                    disabled={disabled || index === 0}
                    onClick={() => move(index, -1)}
                    className="disabled:opacity-30"
                  >
                    <ArrowUp className="h-3 w-3" aria-hidden />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${APPROVER_LABEL[step]} later`}
                    disabled={disabled || index === steps.length - 1}
                    onClick={() => move(index, 1)}
                    className="disabled:opacity-30"
                  >
                    <ArrowDown className="h-3 w-3" aria-hidden />
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${APPROVER_LABEL[step]}`}
                    disabled={disabled}
                    onClick={() => onChangeSteps(steps.filter((_, i) => i !== index))}
                    className="hover:text-status-error disabled:opacity-30"
                  >
                    <X className="h-3 w-3" aria-hidden />
                  </button>
                </span>
                {index < steps.length - 1 && (
                  <span aria-hidden className="text-text-muted">
                    {mode === 'PARALLEL' ? '+' : '→'}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

/**
 * The chain a request walks before it is approved.
 *
 * Steps are named by ROLE rather than by person: a `SUPERVISOR` step resolves
 * to whoever the requester's supervisor is at the moment the request is filed,
 * which is why the assignment panel above and this one belong on one screen.
 */
function ApprovalChains({
  settings,
  onChangeSetting,
  canEdit,
}: {
  settings: Record<string, string>;
  onChangeSetting: (key: string, value: string) => void;
  canEdit: boolean;
}) {
  const kinds = useApprovalKinds();
  const workflows = useApprovalWorkflows();
  const upsert = useUpsertApprovalWorkflow();

  const [drafts, setDrafts] = useState<Record<string, { steps: ApproverType[]; mode: ApprovalMode }>>(
    {},
  );

  const kindList = kinds.data?.data ?? [];

  /**
   * What is on screen: the local edit if there is one, otherwise the stored
   * chain. Seeding state from the query in an effect instead would blank an
   * administrator's unsaved edits every time the list refetched.
   */
  const chainOf = (type: ApprovalRequestType) => {
    if (drafts[type]) return drafts[type];
    const stored = (workflows.data?.data ?? []).find(
      (workflow) => workflow.requestType === type && workflow.isActive,
    );
    return {
      steps: [...(stored?.steps ?? [])]
        .sort((a, b) => a.stepOrder - b.stepOrder)
        .map((step) => step.approverType),
      mode: stored?.mode ?? ('SEQUENTIAL' as ApprovalMode),
    };
  };

  const edit = (type: ApprovalRequestType, patch: Partial<{ steps: ApproverType[]; mode: ApprovalMode }>) =>
    setDrafts((current) => ({ ...current, [type]: { ...chainOf(type), ...patch } }));

  const save = async () => {
    const edited = Object.keys(drafts) as ApprovalRequestType[];
    if (edited.length === 0) {
      toast.success('Nothing to save');
      return;
    }

    try {
      for (const type of edited) {
        const chain = drafts[type];
        const label = kindList.find((kind) => kind.type === type)?.label ?? type;
        await upsert.mutateAsync({
          requestType: type,
          name: `${label} approval chain`,
          mode: chain.mode,
          // A chain emptied on screen is saved as an INACTIVE workflow rather
          // than skipped. Skipping it leaves the stored chain live, so clearing
          // one in the UI would appear to work and change nothing.
          isActive: chain.steps.length > 0,
          steps: chain.steps.map((approverType) => ({ approverType })),
        });
      }
      setDrafts({});
      toast.success('Approval chains saved');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not save the approval chains'));
    }
  };

  return (
    <SectionCard
      title="Approval chains"
      description="Route a request through an ordered set of roles rather than a single approver"
      icon={GitBranch}
      action={
        canEdit ? (
          <Button
            size="sm"
            onClick={save}
            isLoading={upsert.isPending}
            disabled={Object.keys(drafts).length === 0}
          >
            Save chains
          </Button>
        ) : undefined
      }
    >
      <ToggleRow
        label="Use approval chains"
        description="With this off, every request falls back to the plain single-approver rule whatever the chains below say."
        disabled={!canEdit}
        checked={settings[APPROVAL_MASTER_KEY] === 'true'}
        onChange={(value) => onChangeSetting(APPROVAL_MASTER_KEY, value ? 'true' : 'false')}
      />

      {kinds.isLoading || workflows.isLoading ? (
        <p className="py-6 text-center text-sm text-text-muted">Loading chains…</p>
      ) : kindList.length === 0 ? (
        <EmptyState
          title="No request types to govern"
          description="The server's approval registry is empty, so there is nothing a chain could route."
          icon={<GitBranch className="h-6 w-6" aria-hidden />}
        />
      ) : (
        <div className={cn('space-y-3', !canEdit && 'opacity-80')}>
          {kindList.map((kind) => {
            const chain = chainOf(kind.type);
            return (
              <ChainEditor
                key={kind.type}
                label={kind.label}
                steps={chain.steps}
                mode={chain.mode}
                disabled={!canEdit}
                onChangeSteps={(steps) => edit(kind.type, { steps })}
                onChangeMode={(mode) => edit(kind.type, { mode })}
              />
            );
          })}
        </div>
      )}

      <p className="text-xs text-text-muted">
        A step with nobody behind it is skipped rather than left to stall the request, so
        a chain never dead-ends. One rejection closes the request whatever the mode.
        Being a supervisor grants no administrative permission of its own.
      </p>
    </SectionCard>
  );
}

export function SupervisorHierarchySection({
  settings,
  onChangeSetting,
  canEdit,
}: {
  settings: Record<string, string>;
  onChangeSetting: (key: string, value: string) => void;
  /** ADMIN. HR may assign supervisors but only an administrator may write a chain. */
  canEdit: boolean;
}) {
  return (
    <div className="space-y-4 sm:space-y-5">
      <SupervisorAssignments />
      <ApprovalChains settings={settings} onChangeSetting={onChangeSetting} canEdit={canEdit} />
    </div>
  );
}

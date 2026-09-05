'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Pencil, Trash2, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useEmployees } from '@/hooks/useEmployees';
import { usePageHeader } from '@/hooks/usePageHeader';
import {
  useAddTeamMember,
  useRemoveTeamMember,
  useTeam,
  useUpdateTeamMember,
} from '@/hooks/useTeams';
import { useAuthStore } from '@/store/authStore';
import { apiErrorMessage } from '@/utils/apiError';
import { formatDateOnly } from '@/utils/formatDate';
import { fullName } from '@/utils/formatters';
import { hasPermission } from '@/utils/permissions';
import type { TeamMemberRole } from '@/types/team';

const ROLE_OPTIONS: Array<{ value: TeamMemberRole; label: string }> = [
  { value: 'LEAD', label: 'Lead' },
  { value: 'MEMBER', label: 'Member' },
  { value: 'CONTRIBUTOR', label: 'Contributor' },
];

const ROLE_TONE: Record<TeamMemberRole, 'success' | 'neutral' | 'info'> = {
  LEAD: 'success',
  MEMBER: 'neutral',
  CONTRIBUTOR: 'info',
};

function TeamRoster({ id }: { id: string }) {
  const role = useAuthStore((s) => s.user?.role);
  const canEdit = hasPermission(role, 'EDIT_EMPLOYEE');

  const { data, isLoading, isError } = useTeam(id);
  const team = data?.data;

  const addMember = useAddTeamMember();
  const updateMember = useUpdateTeamMember();
  const removeMember = useRemoveTeamMember();

  const [newMemberId, setNewMemberId] = useState('');
  const [newMemberRole, setNewMemberRole] = useState<TeamMemberRole>('MEMBER');
  const [newAllocation, setNewAllocation] = useState('100');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editAllocation, setEditAllocation] = useState('100');

  const members = useMemo(() => team?.members ?? [], [team]);
  const active = members.filter((member) => member.isActive);
  const committed = active.reduce((sum, member) => sum + member.allocation, 0);

  usePageHeader(
    team?.name ?? 'Team',
    team
      ? `${team.department?.name ?? 'No department'} · ${active.length} member${
          active.length === 1 ? '' : 's'
        }`
      : undefined,
  );

  // Somebody already on the roster — live or closed — is not an "add". Their row
  // carries the action instead, which is also what keeps the same person from
  // appearing twice on one screen.
  const rostered = new Set(members.map((member) => member.employeeId));
  const people = useEmployees({ limit: 200, status: 'ACTIVE', sortBy: 'firstName', sortOrder: 'asc' });
  const candidates = (people.data?.data ?? []).filter((person) => !rostered.has(person.id));

  if (isLoading) {
    return <Card className="p-6 text-sm text-text-muted">Loading the roster…</Card>;
  }

  if (isError || !team) {
    return <Card className="p-6 text-sm text-status-error">Could not load this team.</Card>;
  }

  const leadIsRostered = team.teamLeadId
    ? members.some((member) => member.employeeId === team.teamLeadId)
    : false;

  const handleAdd = async () => {
    if (!newMemberId) return;
    try {
      await addMember.mutateAsync({
        teamId: team.id,
        payload: {
          employeeId: newMemberId,
          role: newMemberRole,
          allocation: Number(newAllocation) || 0,
        },
      });
      toast.success('Added to the team');
      setNewMemberId('');
      setNewAllocation('100');
      setNewMemberRole('MEMBER');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not add that person'));
    }
  };

  const handleReinstate = async (employeeId: string) => {
    try {
      // Re-adding reactivates the existing row rather than inserting a second
      // one, so the roster count stays honest.
      await addMember.mutateAsync({ teamId: team.id, payload: { employeeId } });
      toast.success('Membership reopened');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not reopen that membership'));
    }
  };

  const handleSaveAllocation = async (memberId: string) => {
    try {
      await updateMember.mutateAsync({
        teamId: team.id,
        memberId,
        payload: { allocation: Number(editAllocation) || 0 },
      });
      toast.success('Allocation updated');
      setEditingId(null);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not update the allocation'));
    }
  };

  const handleRemove = async (memberId: string, name: string) => {
    try {
      await removeMember.mutateAsync({ teamId: team.id, memberId });
      toast.success(`${name} removed from the team`);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not remove that person'));
    }
  };

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <dl className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-text-muted">Code</dt>
            <dd className="mt-1 text-sm text-text-body">{team.code}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-text-muted">Type</dt>
            <dd className="mt-1 text-sm text-text-body">{team.type.replace(/_/g, ' ')}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-text-muted">
              Committed effort
            </dt>
            {/* The sum of allocations, not the headcount: four people at 25% is
                one full-time equivalent, and the roster count hides that. */}
            <dd className="mt-1 text-sm tabular-nums text-text-body">{committed}%</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-text-muted">Status</dt>
            <dd className="mt-1 text-sm">
              <Badge tone={team.isActive ? 'success' : 'neutral'}>
                {team.isActive ? 'Active' : 'Disbanded'}
              </Badge>
            </dd>
          </div>
          {/* The lead is named here only when they are not on the roster below.
              When they are, their row already carries the badge, and saying it
              twice on one screen is noise rather than emphasis. */}
          {team.teamLead && !leadIsRostered && (
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-text-muted">
                Team lead
              </dt>
              <dd className="mt-1 text-sm">
                <Link
                  href={`/dashboard/employees/${team.teamLead.id}`}
                  className="text-brand-primary hover:underline"
                >
                  {fullName(team.teamLead)}
                </Link>
              </dd>
            </div>
          )}
          {team.description && (
            <div className="sm:col-span-2 lg:col-span-4">
              <dt className="text-xs font-medium uppercase tracking-wide text-text-muted">
                Remit
              </dt>
              <dd className="mt-1 text-sm text-text-body">{team.description}</dd>
            </div>
          )}
        </dl>
      </Card>

      <Card>
        <CardHeader title="Roster" subtitle="Who is on this team, and how much of them." />
        {members.length === 0 ? (
          <p className="px-5 pb-5 text-sm text-text-muted">Nobody is on this team yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="border-y border-surface-border-light text-xs uppercase tracking-wide text-text-muted">
                <tr>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Member</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Role</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Allocation</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Since</th>
                  {canEdit && (
                    <th scope="col" className="px-5 py-3 text-end font-medium">
                      Actions
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border-light">
                {members.map((member) => {
                  const name = fullName(member.employee);
                  const editing = editingId === member.id;

                  return (
                    <tr
                      key={member.id}
                      className={`hover:bg-surface-border-light/60 ${
                        member.isActive ? '' : 'opacity-60'
                      }`}
                    >
                      <td className="px-5 py-3">
                        {member.employee ? (
                          <Link
                            href={`/dashboard/employees/${member.employeeId}`}
                            className="font-medium text-brand-primary hover:underline"
                          >
                            {name}
                          </Link>
                        ) : (
                          <span className="text-text-body">{name}</span>
                        )}
                        {!member.isActive && (
                          <span className="ms-2 align-middle">
                            <Badge tone="neutral">Closed</Badge>
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        <Badge tone={ROLE_TONE[member.role]}>{member.role}</Badge>
                      </td>
                      <td className="px-5 py-3">
                        {editing ? (
                          <div className="flex items-center gap-2">
                            <Input
                              type="number"
                              min={0}
                              max={100}
                              className="w-24"
                              aria-label={`Allocation for ${name}`}
                              value={editAllocation}
                              onChange={(event) => setEditAllocation(event.target.value)}
                            />
                            <Button
                              size="sm"
                              onClick={() => handleSaveAllocation(member.id)}
                              isLoading={updateMember.isPending}
                            >
                              Save
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                              Cancel
                            </Button>
                          </div>
                        ) : (
                          <span className="tabular-nums text-text-body">{member.allocation}%</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-text-body">
                        {formatDateOnly(member.startDate)}
                      </td>
                      {canEdit && (
                        <td className="px-5 py-3">
                          <div className="flex items-center justify-end gap-2">
                            {member.isActive ? (
                              <>
                                {!editing && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    aria-label={`Edit allocation for ${name}`}
                                    onClick={() => {
                                      setEditingId(member.id);
                                      setEditAllocation(String(member.allocation));
                                    }}
                                  >
                                    <Pencil className="h-3.5 w-3.5" aria-hidden />
                                  </Button>
                                )}
                                <Button
                                  size="sm"
                                  variant="outline"
                                  aria-label={`Remove ${name} from the team`}
                                  onClick={() => handleRemove(member.id, name)}
                                >
                                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                                </Button>
                              </>
                            ) : (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleReinstate(member.employeeId)}
                              >
                                Reinstate
                              </Button>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {canEdit && (
        <Card>
          <CardHeader
            title="Add a member"
            subtitle="Allocation is the share of their week this team gets."
          />
          <CardBody className="grid items-end gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Select
              label="Employee"
              placeholder="Choose somebody"
              value={newMemberId}
              onChange={(event) => setNewMemberId(event.target.value)}
            >
              {candidates.map((person) => (
                <option key={person.id} value={person.id}>
                  {fullName(person)}
                </option>
              ))}
            </Select>
            <Select
              label="Role"
              value={newMemberRole}
              onChange={(event) => setNewMemberRole(event.target.value as TeamMemberRole)}
            >
              {ROLE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
            <Input
              type="number"
              min={0}
              max={100}
              label="Allocation %"
              value={newAllocation}
              onChange={(event) => setNewAllocation(event.target.value)}
            />
            <Button onClick={handleAdd} disabled={!newMemberId} isLoading={addMember.isPending}>
              <UserPlus className="h-4 w-4" aria-hidden />
              Add member
            </Button>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

export default function TeamPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';

  return (
    <ProtectedRoute requiredPermission="VIEW_EMPLOYEES">
      <TeamRoster id={id} />
    </ProtectedRoute>
  );
}

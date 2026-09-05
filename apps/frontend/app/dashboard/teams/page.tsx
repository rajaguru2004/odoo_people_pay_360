'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Plus, UsersRound } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Select } from '@/components/ui/Select';
import { EmptyState } from '@/components/common/EmptyState';
import { useDepartments } from '@/hooks/useDepartments';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useTeams } from '@/hooks/useTeams';
import { useAuthStore } from '@/store/authStore';
import { fullName } from '@/utils/formatters';
import { hasPermission } from '@/utils/permissions';

function TeamsList() {
  const role = useAuthStore((s) => s.user?.role);
  const [departmentId, setDepartmentId] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);

  const { data, isLoading, isError } = useTeams({
    departmentId: departmentId || undefined,
    includeInactive,
  });
  const departments = useDepartments();

  const teams = data?.data ?? [];

  usePageHeader('Teams', `${teams.length} working group${teams.length === 1 ? '' : 's'}`);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-56">
            <Select
              aria-label="Filter by department"
              placeholder="Every department"
              value={departmentId}
              onChange={(event) => setDepartmentId(event.target.value)}
            >
              {(departments.data?.data ?? []).map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </Select>
          </div>
          <label className="flex items-center gap-2 text-sm text-text-body">
            <input
              type="checkbox"
              className="h-4 w-4 rounded-sm border-surface-border accent-brand-primary"
              checked={includeInactive}
              onChange={(event) => setIncludeInactive(event.target.checked)}
            />
            Include disbanded teams
          </label>
        </div>

        {hasPermission(role, 'EDIT_EMPLOYEE') && (
          <Link href="/dashboard/teams/new">
            <Button>
              <Plus className="h-4 w-4" aria-hidden />
              New team
            </Button>
          </Link>
        )}
      </div>

      <Card>
        {isLoading && <p className="p-6 text-sm text-text-muted">Loading teams…</p>}

        {isError && (
          <p className="p-6 text-sm text-status-error">Could not load teams. Is the API running?</p>
        )}

        {!isLoading && !isError && teams.length === 0 && (
          <EmptyState
            icon={<UsersRound className="h-6 w-6" aria-hidden />}
            title="Nothing here yet"
            description={
              departmentId
                ? 'This department has no working groups yet.'
                : 'Create the first team to group people across departments.'
            }
          />
        )}

        {teams.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="border-b border-surface-border-light text-xs uppercase tracking-wide text-text-muted">
                <tr>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Code</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Team</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Department</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Lead</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Type</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Members</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border-light">
                {teams.map((team) => (
                  <tr key={team.id} className="hover:bg-surface-border-light/60">
                    <td className="px-5 py-3 font-medium text-text-heading">{team.code}</td>
                    <td className="px-5 py-3">
                      <Link
                        href={`/dashboard/teams/${team.id}`}
                        className="font-medium text-brand-primary hover:underline"
                      >
                        {team.name}
                      </Link>
                      {!team.isActive && (
                        <span className="ms-2 align-middle">
                          <Badge tone="neutral">Disbanded</Badge>
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-text-body">{team.department?.name ?? '—'}</td>
                    <td className="px-5 py-3 text-text-body">{fullName(team.teamLead)}</td>
                    <td className="px-5 py-3 text-text-body">{team.type.replace(/_/g, ' ')}</td>
                    <td className="px-5 py-3 tabular-nums text-text-body">
                      {team._count?.members ?? team.members?.length ?? 0}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

export default function TeamsPage() {
  return (
    <ProtectedRoute requiredPermission="VIEW_EMPLOYEES">
      <TeamsList />
    </ProtectedRoute>
  );
}

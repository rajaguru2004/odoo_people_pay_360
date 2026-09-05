'use client';

import { Mail, UsersRound } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/common/EmptyState';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useMySupervisees } from '@/hooks/useSupervisors';
import { apiErrorMessage } from '@/utils/apiError';
import { initials } from '@/utils/formatters';

function MyTeamScreen() {
  const { data, isLoading, isError, error } = useMySupervisees();
  const team = data?.data?.data ?? [];

  usePageHeader(
    'My team',
    team.length === 1
      ? '1 person you sign for'
      : `${team.length} people you sign for`,
  );

  return (
    <div className="space-y-5" data-testid="ess-my-team">
      <Card>
        {isLoading && (
          <p className="p-6 text-sm text-text-muted">Loading your team…</p>
        )}

        {isError && (
          <p className="p-6 text-sm text-status-error">
            {apiErrorMessage(error, 'Could not load your team.')}
          </p>
        )}

        {!isLoading && !isError && team.length === 0 && (
          <EmptyState
            icon={<UsersRound className="h-6 w-6" aria-hidden />}
            title="Nobody reports to you yet"
            description="When somebody is routed to you as their supervisor, their leave, overtime and timesheets come here for your decision."
          />
        )}

        {team.length > 0 && (
          <ul className="divide-y divide-surface-border-light">
            {team.map((person) => (
              <li
                key={person.id}
                data-testid={`my-team-member-${person.id}`}
                className="flex flex-wrap items-center justify-between gap-3 px-5 py-4"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span
                    aria-hidden
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-primary/10 text-sm font-semibold text-brand-primary"
                  >
                    {initials(person)}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-text-heading">
                      {person.fullName}
                    </p>
                    <p className="truncate text-xs text-text-muted">
                      {person.employeeCode}
                      {person.position ? ` · ${person.position}` : ''}
                      {person.department ? ` · ${person.department.name}` : ''}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  {person.status !== 'ACTIVE' && (
                    <Badge tone="warning">{person.status.replace('_', ' ')}</Badge>
                  )}
                  {person.email && (
                    <a
                      href={`mailto:${person.email}`}
                      className="inline-flex max-w-full items-center gap-1.5 truncate text-xs font-medium text-text-muted hover:text-brand-primary"
                    >
                      <Mail className="h-4 w-4 shrink-0" aria-hidden />
                      {person.email}
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

export default function MyTeamPage() {
  return (
    <ProtectedRoute>
      <MyTeamScreen />
    </ProtectedRoute>
  );
}

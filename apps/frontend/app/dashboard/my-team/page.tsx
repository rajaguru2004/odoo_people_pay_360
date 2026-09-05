'use client';

import { useEffect, useState } from 'react';
import { Loader2, Mail } from 'lucide-react';
import { toast } from 'sonner';
import supervisorService, {
  SupervisedEmployee,
} from '@/services/supervisorService';
import { usePageHeader } from '@/hooks/usePageHeader';

export default function MyTeamPage() {
  // The one heading for this route, rendered by TopHeader.
  usePageHeader('My Team', 'Employees who report to you as their supervisor');

  const [team, setTeam] = useState<SupervisedEmployee[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supervisorService
      .getMyTeam()
      .then((res) => setTeam(Array.isArray(res.data) ? res.data : []))
      .catch((e: any) =>
        toast.error(e?.response?.data?.message || 'Failed to load your team'),
      )
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="p-4 md:p-6" data-testid="ess-my-team">
      {/* Heading lives in TopHeader via usePageHeader — no action belongs here. */}

      <div className="rounded-2xl border border-surface-border bg-surface-card shadow-sm">
        {loading ? (
          <div className="flex items-center gap-2 p-8 text-text-muted">
            <Loader2 className="h-5 w-5 animate-spin" /> Loading…
          </div>
        ) : team.length === 0 ? (
          <div className="p-10 text-center text-text-muted">
            You don&apos;t supervise anyone yet.
          </div>
        ) : (
          <ul className="divide-y divide-surface-border-light">
            {team.map((e) => (
              <li
                key={e.id}
                className="flex flex-wrap items-center justify-between gap-2 p-4 hover:bg-surface-page md:flex-nowrap md:gap-4"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-primary/10 text-sm font-bold text-brand-primary">
                    {e.fullName?.charAt(0) || '?'}
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-text-heading">
                      {e.fullName}
                    </p>
                    <p className="text-xs text-text-muted">
                      {e.position}
                      {e.department?.name ? ` · ${e.department.name}` : ''} ·{' '}
                      {e.employeeCode}
                    </p>
                  </div>
                </div>
                {e.email && (
                  <a
                    href={`mailto:${e.email}`}
                    className="inline-flex min-w-0 max-w-full items-center gap-1.5 truncate text-xs font-medium text-text-muted hover:text-brand-primary"
                    title={e.email}
                  >
                    <Mail size={15} /> {e.email}
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

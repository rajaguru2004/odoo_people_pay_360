'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { GitBranch, LayoutGrid, Plus, Users } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import DepartmentTreeNode from '@/components/departments/DepartmentTreeNode';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/common/EmptyState';
import { StatCard } from '@/components/common/StatCard';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useDepartmentTree } from '@/hooks/useDepartments';
import { useAuthStore } from '@/store/authStore';
import { hasPermission } from '@/utils/permissions';
import type { DepartmentNode } from '@/types/department';

function walk(nodes: DepartmentNode[]): { units: number; people: number; depth: number } {
  return nodes.reduce(
    (totals, node) => {
      const below = walk(node.children ?? []);
      return {
        units: totals.units + 1 + below.units,
        people: totals.people + node.employees + below.people,
        depth: Math.max(totals.depth, 1 + below.depth),
      };
    },
    { units: 0, people: 0, depth: 0 },
  );
}

function OrganisationalChartContent() {
  const role = useAuthStore((s) => s.user?.role);
  const canManage = hasPermission(role, 'MANAGE_DEPARTMENTS');

  const { data, isLoading, isError } = useDepartmentTree();
  const roots = useMemo(() => data?.data ?? [], [data]);
  const totals = useMemo(() => walk(roots), [roots]);

  usePageHeader(
    'Organisational chart',
    `${totals.units} units across ${totals.depth} ${totals.depth === 1 ? 'level' : 'levels'}`,
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-end gap-3">
        <Link href="/dashboard/departments">
          <Button variant="outline">
            <LayoutGrid className="h-4 w-4" aria-hidden />
            List view
          </Button>
        </Link>
        {canManage && (
          <Link href="/dashboard/departments/new">
            <Button>
              <Plus className="h-4 w-4" aria-hidden />
              New department
            </Button>
          </Link>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Units"
          value={totals.units}
          icon={<GitBranch className="h-5 w-5" aria-hidden />}
        />
        <StatCard
          label="People placed"
          value={totals.people}
          icon={<Users className="h-5 w-5" aria-hidden />}
        />
        <StatCard label="Top level" value={roots.length} hint="Units reporting to nobody" />
      </div>

      {isLoading && <Card className="p-6 text-sm text-text-muted">Drawing the chart…</Card>}

      {isError && (
        <Card className="p-6 text-sm text-status-error">
          The hierarchy could not be read, so this page is showing nothing rather than a shape it
          cannot vouch for.
        </Card>
      )}

      {!isLoading && !isError && roots.length === 0 && (
        <Card>
          <EmptyState
            icon={<GitBranch className="h-6 w-6" aria-hidden />}
            title="Nothing to draw"
            description="No unit has been recorded yet, so there is no hierarchy to show."
          />
        </Card>
      )}

      {roots.length > 0 && (
        // The chart scrolls inside its own box: a deep hierarchy indents past
        // the panel edge, and letting the page scroll sideways instead moves
        // the whole shell.
        <Card className="overflow-x-auto bg-surface-page p-5">
          <div className="min-w-fit">
            {roots.map((node) => (
              <DepartmentTreeNode key={node.id} node={node} />
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

export default function OrganisationalChartPage() {
  return (
    <ProtectedRoute requiredPermission="VIEW_DEPARTMENTS">
      <OrganisationalChartContent />
    </ProtectedRoute>
  );
}

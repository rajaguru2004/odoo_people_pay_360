'use client';

import Link from 'next/link';
import { UserX } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { fullName } from '@/utils/formatters';
import type { Department } from '@/types/department';

/**
 * The same departments as rows.
 *
 * Head and branch sit next to each other because the question this view answers
 * is "who signs for the people at this site" — which a card grid can only
 * answer one card at a time.
 */
export default function DepartmentTableView({ departments }: { departments: Department[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[880px] text-sm">
        <thead className="border-b border-surface-border-light text-xs uppercase tracking-wide text-text-muted">
          <tr>
            <th scope="col" className="px-5 py-3 text-start font-medium">Code</th>
            <th scope="col" className="px-5 py-3 text-start font-medium">Department</th>
            <th scope="col" className="px-5 py-3 text-start font-medium">Reports to</th>
            <th scope="col" className="px-5 py-3 text-start font-medium">Branch</th>
            <th scope="col" className="px-5 py-3 text-start font-medium">Head</th>
            <th scope="col" className="px-5 py-3 text-start font-medium">People</th>
            <th scope="col" className="px-5 py-3 text-start font-medium">Sub-units</th>
            <th scope="col" className="px-5 py-3 text-start font-medium">State</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-surface-border-light">
          {departments.map((department) => (
            <tr
              key={department.id}
              data-testid={`department-row-${department.code}`}
              className="hover:bg-surface-border-light/60"
            >
              <td className="px-5 py-3 font-medium text-text-muted">{department.code}</td>
              <td className="px-5 py-3">
                <Link
                  href={`/dashboard/departments/${department.id}`}
                  className="font-medium text-brand-primary hover:underline"
                >
                  {department.name}
                </Link>
              </td>
              <td className="px-5 py-3 text-text-body">
                {department.parent?.name ?? <span className="text-text-muted">Top level</span>}
              </td>
              <td className="px-5 py-3 text-text-body">
                {department.branch?.name ?? <span className="text-text-muted">—</span>}
              </td>
              <td className="px-5 py-3">
                {department.manager ? (
                  <span className="text-text-body">{fullName(department.manager)}</span>
                ) : (
                  <span className="inline-flex items-center gap-1 font-medium text-status-warning">
                    <UserX className="h-3.5 w-3.5" aria-hidden />
                    Nobody
                  </span>
                )}
              </td>
              <td className="px-5 py-3 tabular-nums text-text-body">
                {department._count?.employees ?? 0}
              </td>
              <td className="px-5 py-3 tabular-nums text-text-body">
                {department._count?.children ?? department.children?.length ?? 0}
              </td>
              <td className="px-5 py-3">
                {department.isActive ? (
                  <Badge tone="success">Open</Badge>
                ) : (
                  <Badge tone="error">Closed</Badge>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

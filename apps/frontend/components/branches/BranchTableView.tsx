'use client';

import Link from 'next/link';
import { Navigation, TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { fullName } from '@/utils/formatters';
import {
  branchLocation,
  hasCompleteFence,
  hasIncompleteFence,
  officeWindow,
  weeklyOff,
} from './branchFacts';
import type { Branch } from '@/types/branch';

/**
 * The same branches as rows.
 *
 * Wider than the card grid on purpose — the whole point of the table view is
 * comparing the working calendar across sites — so it scrolls inside its own
 * wrapper rather than putting a scrollbar on the page.
 */
export default function BranchTableView({ branches }: { branches: Branch[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[900px] text-sm">
        <thead className="border-b border-surface-border-light text-xs uppercase tracking-wide text-text-muted">
          <tr>
            <th scope="col" className="px-5 py-3 text-start font-medium">Code</th>
            <th scope="col" className="px-5 py-3 text-start font-medium">Branch</th>
            <th scope="col" className="px-5 py-3 text-start font-medium">Location</th>
            <th scope="col" className="px-5 py-3 text-start font-medium">Manager</th>
            <th scope="col" className="px-5 py-3 text-start font-medium">People</th>
            <th scope="col" className="px-5 py-3 text-start font-medium">Office window</th>
            <th scope="col" className="px-5 py-3 text-start font-medium">Geofence</th>
            <th scope="col" className="px-5 py-3 text-start font-medium">State</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-surface-border-light">
          {branches.map((branch) => {
            const where = branchLocation(branch);
            const hours = officeWindow(branch);
            const off = weeklyOff(branch);

            return (
              <tr
                key={branch.id}
                data-testid={`branch-row-${branch.code}`}
                className="hover:bg-surface-border-light/60"
              >
                <td className="px-5 py-3 font-medium tabular-nums text-text-muted">
                  {branch.code}
                </td>
                <td className="px-5 py-3">
                  <Link
                    href={`/dashboard/branches/${branch.id}`}
                    className="font-medium text-brand-primary hover:underline"
                  >
                    {branch.name}
                  </Link>
                </td>
                <td className="px-5 py-3 text-text-body">
                  {where ?? <span className="text-text-muted">—</span>}
                </td>
                <td className="px-5 py-3 text-text-body">{fullName(branch.manager)}</td>
                <td className="px-5 py-3 tabular-nums text-text-body">
                  {branch._count?.employees ?? 0}
                </td>
                <td className="px-5 py-3 text-text-body">
                  {/* An inherited window is not a blank: the branch works the
                      company hours, which is a different fact from "unknown". */}
                  {hours ? (
                    <span className="tabular-nums">{hours}</span>
                  ) : (
                    <span className="text-text-muted">Company default</span>
                  )}
                  {off && <span className="ms-2 text-xs text-text-muted">Off {off}</span>}
                </td>
                <td className="px-5 py-3">
                  {hasCompleteFence(branch) ? (
                    <span className="inline-flex items-center gap-1 text-status-info">
                      <Navigation className="h-3.5 w-3.5" aria-hidden />
                      {branch.geofenceRadiusM} m
                    </span>
                  ) : hasIncompleteFence(branch) ? (
                    <span className="inline-flex items-center gap-1 text-status-warning">
                      <TriangleAlert className="h-3.5 w-3.5" aria-hidden />
                      No centre
                    </span>
                  ) : (
                    <span className="text-text-muted">Off</span>
                  )}
                </td>
                <td className="px-5 py-3">
                  {branch.isActive ? (
                    <Badge tone="success">Open</Badge>
                  ) : (
                    <Badge tone="error">Retired</Badge>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

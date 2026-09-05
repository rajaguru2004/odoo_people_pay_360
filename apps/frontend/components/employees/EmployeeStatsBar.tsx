'use client';

import { UserCheck, UserMinus, UserRoundX, Users, UserX } from 'lucide-react';
import { StatCard } from '@/components/common/StatCard';
import type { EmployeeHeadcount } from './employeeFacts';
import type { EmployeeStatus } from '@/types/employee';

/** An unknown figure prints an em dash; only a real count prints a number. */
function Figure({ value, testId }: { value: number | null; testId: string }) {
  return <span data-testid={testId}>{value === null ? '—' : value}</span>;
}

const TILES: ReadonlyArray<{
  status: EmployeeStatus;
  label: string;
  hint: string;
  icon: typeof UserCheck;
}> = [
  {
    status: 'ACTIVE',
    label: 'Active',
    hint: 'On the books and working',
    icon: UserCheck,
  },
  {
    status: 'ON_LEAVE',
    label: 'On leave',
    hint: 'Still employed, away',
    icon: UserMinus,
  },
  {
    status: 'SUSPENDED',
    label: 'Suspended',
    hint: 'Employment paused',
    icon: UserRoundX,
  },
  {
    status: 'TERMINATED',
    label: 'Terminated',
    hint: 'Record kept for payslips',
    icon: UserX,
  },
];

/**
 * Headcount by status, above the list.
 *
 * The figures follow every filter EXCEPT the status one, so the four status
 * tiles always add up to the total beside them. Letting the status filter reach
 * these as well would leave a reader looking at "Active 19, Total 19" the
 * moment they filtered to active, which says nothing and reads as a bug.
 *
 * Terminated is on the bar rather than hidden as an exception: the record
 * survives termination because payslips still resolve to it, and a workforce
 * figure that quietly omits those people disagrees with every payroll report.
 */
export default function EmployeeStatsBar({
  headcount,
}: {
  headcount: EmployeeHeadcount;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
      <StatCard
        label="Total workforce"
        value={<Figure value={headcount.total} testId="employee-stat-total" />}
        hint="Every record, whatever its status"
        icon={<Users className="h-5 w-5" aria-hidden />}
      />
      {TILES.map((tile) => {
        const Icon = tile.icon;
        return (
          <StatCard
            key={tile.status}
            label={tile.label}
            value={
              <Figure
                value={headcount.byStatus[tile.status]}
                testId={`employee-stat-${tile.status.toLowerCase()}`}
              />
            }
            hint={tile.hint}
            icon={<Icon className="h-5 w-5" aria-hidden />}
          />
        );
      })}
    </div>
  );
}

'use client';

import Link from 'next/link';
import { Building2, CalendarDays, Mail, MapPin } from 'lucide-react';
import { motion } from 'framer-motion';
import { Badge } from '@/components/ui/Badge';
import { formatDateOnly } from '@/utils/formatDate';
import { fullName, initials } from '@/utils/formatters';
import { EMPLOYEE_STATUS_TONE, employeeStatusLabel } from './employeeFacts';
import type { Employee } from '@/types/employee';

/**
 * One person as a card.
 *
 * Initials rather than a photograph, which is what the record page already
 * draws: the avatar column holds a path served by the API, and a grid of
 * twenty broken images on a deployment that has never had one uploaded is
 * worse than no picture at all.
 *
 * The whole card is the link and the NAME appears exactly once inside it —
 * repeating it in a title attribute would turn "find the person called X" into
 * two hits for the same card.
 */
function EmployeeCard({ employee }: { employee: Employee }) {
  const placement = [employee.department?.name, employee.branch?.name].filter(Boolean);

  return (
    <Link
      href={`/dashboard/employees/${employee.id}`}
      data-testid={`employee-card-${employee.employeeCode}`}
      className="surface-panel group flex h-full flex-col gap-4 rounded-[var(--radius-card)] p-5 transition-all"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-brand-primary/10 text-sm font-semibold text-brand-primary transition-colors group-hover:bg-brand-primary group-hover:text-text-on-brand"
        >
          {initials(employee)}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-semibold text-text-heading transition-colors group-hover:text-brand-primary">
            {fullName(employee)}
          </h3>
          <p className="mt-0.5 text-xs font-medium uppercase tracking-wide text-text-muted">
            {employee.employeeCode}
          </p>
        </div>
        <Badge tone={EMPLOYEE_STATUS_TONE[employee.status]}>
          {employeeStatusLabel(employee.status)}
        </Badge>
      </div>

      <p className="truncate text-sm text-text-body">
        {employee.position ?? <span className="text-text-muted">No position recorded</span>}
      </p>

      <dl className="mt-auto space-y-2 border-t border-surface-border-light pt-3 text-sm">
        <div className="flex items-center gap-1.5">
          <dt className="sr-only">Placement</dt>
          <Building2 className="h-4 w-4 shrink-0 text-text-muted" aria-hidden />
          <dd className="truncate text-text-body">
            {placement.length ? placement.join(' · ') : 'Unassigned'}
          </dd>
        </div>

        <div className="flex items-center gap-1.5">
          <dt className="sr-only">Work email</dt>
          <Mail className="h-4 w-4 shrink-0 text-text-muted" aria-hidden />
          <dd className="truncate text-text-body">{employee.workEmail ?? '—'}</dd>
        </div>

        <div className="flex items-center gap-1.5">
          <dt className="sr-only">Hire date</dt>
          <CalendarDays className="h-4 w-4 shrink-0 text-text-muted" aria-hidden />
          {/* A hire date has no time of day; formatDateOnly is what keeps it
              off the previous day for anyone west of Greenwich. */}
          <dd className="truncate tabular-nums text-text-body">
            {formatDateOnly(employee.hireDate)}
          </dd>
        </div>

        {employee.supervisor && (
          <div className="flex items-center gap-1.5">
            <dt className="sr-only">Supervisor</dt>
            <MapPin className="h-4 w-4 shrink-0 text-text-muted" aria-hidden />
            <dd className="truncate text-text-body">
              Signed off by {fullName(employee.supervisor)}
            </dd>
          </div>
        )}
      </dl>
    </Link>
  );
}

export default function EmployeeCardView({ employees }: { employees: Employee[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {employees.map((employee, i) => (
        <motion.div
          key={employee.id}
          initial={{ opacity: 0, y: 3 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.06 * i }}
        >
          <EmployeeCard employee={employee} />
        </motion.div>
      ))}
    </div>
  );
}

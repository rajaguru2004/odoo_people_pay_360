'use client';

import Link from 'next/link';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { motion } from 'framer-motion';
import { Badge } from '@/components/ui/Badge';
import { formatDateOnly } from '@/utils/formatDate';
import { fullName } from '@/utils/formatters';
import { EMPLOYEE_STATUS_TONE } from './employeeFacts';
import type { Employee, EmployeeListQuery } from '@/types/employee';

export type EmployeeSortColumn = NonNullable<EmployeeListQuery['sortBy']>;

/**
 * A column header that also sorts, with the direction stated for a screen
 * reader rather than only drawn as an arrow.
 *
 * Clicking the column already being sorted flips the direction; clicking a
 * different one starts it ascending, which is what a reader expects from every
 * other table they have used.
 */
function SortableHeader({
  column,
  label,
  active,
  order,
  onSort,
}: {
  column: EmployeeSortColumn;
  label: string;
  active: boolean;
  order: 'asc' | 'desc';
  onSort: (column: EmployeeSortColumn) => void;
}) {
  const Icon = !active ? ArrowUpDown : order === 'asc' ? ArrowUp : ArrowDown;

  return (
    <th
      scope="col"
      aria-sort={active ? (order === 'asc' ? 'ascending' : 'descending') : 'none'}
      className="px-5 py-3 text-start font-medium"
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={`inline-flex items-center gap-1.5 uppercase tracking-wide transition-colors hover:text-text-body ${
          active ? 'text-text-body' : ''
        }`}
      >
        {label}
        <Icon className="h-3 w-3" aria-hidden />
      </button>
    </th>
  );
}

/**
 * The directory as rows — the view the screen opens on.
 *
 * Sorting is a server concern here, not a client one: the table holds one page
 * of a paginated result, so re-ordering the twenty rows in hand would sort the
 * page rather than the workforce.
 */
export default function EmployeeTableView({
  employees,
  sortBy,
  sortOrder,
  onSort,
}: {
  employees: Employee[];
  sortBy: EmployeeSortColumn;
  sortOrder: 'asc' | 'desc';
  onSort: (column: EmployeeSortColumn) => void;
}) {
  return (
    // The wrapper scrolls, not the page: a wide table must never force the
    // whole document into horizontal scroll on a phone.
    <div className="overflow-x-auto">
      <table className="w-full min-w-[840px] text-sm">
        <thead className="border-b border-surface-border-light text-xs uppercase tracking-wide text-text-muted">
          <tr>
            <SortableHeader
              column="employeeCode"
              label="Code"
              active={sortBy === 'employeeCode'}
              order={sortOrder}
              onSort={onSort}
            />
            <SortableHeader
              column="firstName"
              label="Name"
              active={sortBy === 'firstName'}
              order={sortOrder}
              onSort={onSort}
            />
            <th scope="col" className="px-5 py-3 text-start font-medium">
              Department
            </th>
            <th scope="col" className="px-5 py-3 text-start font-medium">
              Branch
            </th>
            <th scope="col" className="px-5 py-3 text-start font-medium">
              Position
            </th>
            <SortableHeader
              column="hireDate"
              label="Hired"
              active={sortBy === 'hireDate'}
              order={sortOrder}
              onSort={onSort}
            />
            <SortableHeader
              column="status"
              label="Status"
              active={sortBy === 'status'}
              order={sortOrder}
              onSort={onSort}
            />
          </tr>
        </thead>
        <tbody className="divide-y divide-surface-border-light">
          {employees.map((employee, i) => (
            <motion.tr
              key={employee.id}
              className="hover:bg-surface-border-light/60"
              initial={{ opacity: 0, y: 2 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.04 * i }}
            >
              <td className="px-5 py-3 font-medium text-text-heading">
                {employee.employeeCode}
              </td>
              <td className="px-5 py-3">
                {/* A real anchor rather than a row click handler, so the
                    record can be opened in a new tab from the list. */}
                <Link
                  href={`/dashboard/employees/${employee.id}`}
                  className="font-medium text-brand-primary hover:underline"
                >
                  {fullName(employee)}
                </Link>
              </td>
              <td className="px-5 py-3 text-text-body">{employee.department?.name ?? '—'}</td>
              <td className="px-5 py-3 text-text-body">{employee.branch?.name ?? '—'}</td>
              <td className="px-5 py-3 text-text-body">{employee.position ?? '—'}</td>
              <td className="px-5 py-3 text-text-body">{formatDateOnly(employee.hireDate)}</td>
              <td className="px-5 py-3">
                <Badge tone={EMPLOYEE_STATUS_TONE[employee.status]}>
                  {employee.status.replace(/_/g, ' ')}
                </Badge>
              </td>
            </motion.tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

'use client';

import Link from 'next/link';
import { formatDateOnly } from '@/utils/formatDate';
import { formatCurrency, fullName } from '@/utils/formatters';
import { toAmount } from '@/utils/payrollTotals';
import type { Money } from '@/types/payroll';
import type { SalaryStructure, SalaryStructureLine } from '@/types/salaryStructure';

/**
 * A row of the assignment register.
 *
 * `GET /salary-structures` does NOT return the lines — it strips them and sends
 * `lineCount` and `grossPay` in their place, summed in the database so a page
 * of twenty rows never has to add up a nested array to say what somebody is
 * paid. `lines` is therefore optional here and the two summary fields are the
 * ones the table reads; the detail endpoint, which does send lines, still fits
 * this shape.
 */
export type SalaryStructureRow = Omit<SalaryStructure, 'lines'> & {
  lines?: SalaryStructureLine[];
  lineCount?: number;
  grossPay?: Money;
};

/** The summed earnings, preferring the server's figure over a re-derivation. */
function grossOf(row: SalaryStructureRow): number | null {
  if (row.grossPay !== undefined && row.grossPay !== null) return toAmount(row.grossPay);
  if (!row.lines) return null;
  return row.lines
    .filter((line) => line.component?.type === 'EARNING')
    .reduce((total, line) => total + toAmount(line.amount), 0);
}

function lineCountOf(row: SalaryStructureRow): number | null {
  if (typeof row.lineCount === 'number') return row.lineCount;
  return row.lines ? row.lines.length : null;
}

/**
 * Who is on a salary structure, and what it comes to.
 *
 * One structure per employee, so a row IS a person: the register answers "is
 * this employee payable", and the gross beside them is the figure a run will
 * start from.
 */
export default function SalaryStructureTable({
  structures,
}: {
  structures: SalaryStructureRow[];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[860px] text-sm">
        <thead className="border-b border-surface-border-light text-xs uppercase tracking-wide text-text-muted">
          <tr>
            <th scope="col" className="px-5 py-3 text-start font-medium">Employee</th>
            <th scope="col" className="px-5 py-3 text-start font-medium">Department</th>
            <th scope="col" className="px-5 py-3 text-start font-medium">Branch</th>
            <th scope="col" className="px-5 py-3 text-start font-medium">Effective from</th>
            <th scope="col" className="px-5 py-3 text-start font-medium">Currency</th>
            <th scope="col" className="px-5 py-3 text-end font-medium">Lines</th>
            <th scope="col" className="px-5 py-3 text-end font-medium">Gross</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-surface-border-light">
          {structures.map((structure) => {
            const gross = grossOf(structure);
            const lines = lineCountOf(structure);

            return (
              <tr key={structure.id} className="hover:bg-surface-border-light/60">
                <td className="px-5 py-3">
                  <Link
                    href={`/dashboard/payroll/structures/${structure.id}`}
                    className="font-medium text-brand-primary hover:underline"
                  >
                    {fullName(structure.employee)}
                  </Link>
                  <p className="text-xs text-text-muted">
                    {structure.employee?.employeeCode ?? '—'}
                  </p>
                </td>
                <td className="px-5 py-3 text-text-body">
                  {structure.employee?.department?.name ?? '—'}
                </td>
                <td className="px-5 py-3 text-text-body">
                  {structure.employee?.branch?.name ?? '—'}
                </td>
                {/* Date only. An instant parse would move an effective-from of
                    the 1st to the previous month west of Greenwich, which
                    renames the period the structure applies to. */}
                <td className="px-5 py-3 text-text-body">
                  {formatDateOnly(structure.effectiveFrom)}
                </td>
                <td className="px-5 py-3 text-text-body">{structure.currency}</td>
                <td className="px-5 py-3 text-end tabular-nums text-text-body">
                  {lines ?? '—'}
                </td>
                {/* The structure's own currency decides the decimal count —
                    three for OMR, two for AED. */}
                <td className="px-5 py-3 text-end font-medium tabular-nums text-text-body">
                  {gross === null ? '—' : formatCurrency(gross, structure.currency)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

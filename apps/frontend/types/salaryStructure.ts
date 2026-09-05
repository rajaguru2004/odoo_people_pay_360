/**
 * The salary catalogue and what each employee is assigned from it.
 *
 * `SalaryComponent` is the catalogue — the set of things a payslip line can be.
 * `SalaryStructure` is one employee's standing assignment of fixed amounts from
 * it, which the calculator reads to build a run.
 */

import type { EmployeeRef } from './common';
import type { Money, SalaryComponentType } from './payroll';

export interface SalaryComponent {
  id: string;
  /** Uppercased on the way in, and unique. A payslip line joins on it, so it
   *  must not depend on how somebody typed it. */
  code: string;
  name: string;
  type: SalaryComponentType;
  /** Counts toward gratuity / end-of-service accrual. */
  isGratuityBase: boolean;
  isTaxable: boolean;
  /** Display order on a payslip. Lower comes first. */
  sequence: number;
  /** False once retired. There is no DELETE: a component behind a payslip line
   *  must keep resolving, so it is deactivated instead. */
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface SalaryComponentListQuery {
  page?: number;
  limit?: number;
  type?: SalaryComponentType;
  /** Serialised as `true` / `false`; the backend reads it as a boolean string. */
  isActive?: boolean;
  /** Matches code or name. */
  search?: string;
}

export interface CreateSalaryComponentPayload {
  code: string;
  name: string;
  type: SalaryComponentType;
  isGratuityBase?: boolean;
  isTaxable?: boolean;
  sequence?: number;
}

/**
 * `code` and `type` cannot be edited, on purpose.
 *
 * Both are joined on by payslip lines that already exist: renaming a code
 * orphans every report grouping by it, and turning an earning into a deduction
 * changes the meaning of money already paid. Retire the component and create
 * its successor instead.
 */
export type UpdateSalaryComponentPayload = Partial<
  Omit<CreateSalaryComponentPayload, 'code' | 'type'>
>;

// ── Structures ──────────────────────────────────────────────────────────────

export interface SalaryStructureLine {
  id: string;
  componentId: string;
  amount: Money;
  component?: SalaryComponent;
}

export interface SalaryStructure {
  id: string;
  employeeId: string;
  currency: string;
  /** Date-only — `formatDateOnly`, never an instant parse. */
  effectiveFrom: string;
  employee?: EmployeeRef & {
    department?: { id: string; name: string } | null;
    branch?: { id: string; name: string } | null;
  };
  lines: SalaryStructureLine[];
  createdAt?: string;
  updatedAt?: string;
}

export interface SalaryStructureListQuery {
  page?: number;
  limit?: number;
  search?: string;
  branchId?: string;
  departmentId?: string;
}

export interface SalaryStructureLinePayload {
  componentId: string;
  /** Sent as a number; it lands in `Decimal(18, 3)`. */
  amount: number;
}

export interface CreateSalaryStructurePayload {
  employeeId: string;
  /** Defaults to the contract's currency, which the server refuses to
   *  contradict — a structure priced in a currency the contract does not use
   *  cannot be paid. */
  currency?: string;
  effectiveFrom: string;
  /** At least one EARNING, and no component twice. */
  lines: SalaryStructureLinePayload[];
}

/** Lines are REPLACED wholesale when present, never merged. */
export type UpdateSalaryStructurePayload = Partial<
  Omit<CreateSalaryStructurePayload, 'employeeId'>
>;

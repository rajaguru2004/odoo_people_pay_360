/**
 * Which Employee Profile Template fields map onto REAL DB columns, and which of
 * those an admin may not touch.
 *
 * This registry is CODE, never data. A wrong mapping is a data-corruption bug,
 * not a configuration mistake, so admins can never create a `storage:'COLUMN'`
 * field — they may only add JSONB (custom) fields. `employee-bound-columns.spec.ts`
 * verifies every entry against `Prisma.dmmf`, so a schema change that breaks a
 * binding fails the unit suite rather than production.
 *
 * The two flags are INDEPENDENT axes:
 *
 *   systemRequired — the column is NOT NULL *and has no DB default*, so a row
 *                    cannot exist without it. No scope (company or branch) may
 *                    set `required: false`. This is a floor, not a preference.
 *
 *   locked         — the field may not be deactivated or retyped, because
 *                    something outside the form depends on it. Locking rule —
 *                    lock when ANY of these is true:
 *                      1. money or time arithmetic reads it (payroll, overtime,
 *                         loans, leave accrual);
 *                      2. a regulator or external system reads it (WPS wage
 *                         files, statutory returns);
 *                      3. a foreign key or unique constraint depends on it;
 *                      4. row visibility depends on it (branchId — the branch
 *                         isolation axis);
 *                      5. a legal document templates it (letter-defaults.ts,
 *                         payslip.hbs).
 *                    Otherwise the field is bound-but-optional: full admin
 *                    control, and "delete" is a soft `isActive = false` so the
 *                    column and every stored value survive untouched.
 *
 * Everything an admin invents lives in `employees.custom_fields` (JSONB) and has
 * no entry here.
 */
import { FieldType } from '../common/dynamic-fields/field-def';

export interface BoundColumn {
  /** Template key. Immutable, and equal to the DTO property name so validation
   *  errors key straight onto the request body path the frontend submitted. */
  fieldKey: string;
  table: 'employee' | 'employeeProfile';
  /** Prisma field name on that model (not the @map'd SQL column). */
  column: string;
  /** Inherent to the column; the template may not change it. */
  type: FieldType;
  /** NOT NULL with no DB default => the template can never make it optional. */
  systemRequired: boolean;
  /** Cannot be deactivated. See the locking rule above. */
  locked: boolean;
  /** Live option source for LIBRARY_SELECT fields (a LibraryType name). */
  optionSource?: string;
  /** Shown as a tooltip in the template builder next to the lock icon. */
  reason?: string;
}

/**
 * Columns that are NOT template fields at all: surrogate keys, FK back-links and
 * values the server maintains. The DMMF spec skips these when it asserts that
 * every mandatory column is bound.
 */
export const EXCLUDED_COLUMNS: Record<'employee' | 'employeeProfile', string[]> =
  {
    employee: [
      'id',
      'hasCompleteProfile',
      'profileLastUpdated',
      'createdAt',
      'updatedAt',
      // Values for JSONB template fields — the bag itself is never a field.
      'customFields',
      // Grade is assigned through `POST /grades/assign/:employeeId`, which
      // refuses a salary outside the grade's band and audits the change. A
      // generic profile field would write the FK straight past that check, so
      // an employee could sit on a grade their salary is not eligible for and
      // nothing would ever say so.
      'gradeId',
    ],
    employeeProfile: [
      'id',
      'employeeId',
      'profileCompletionPercentage',
      'lastProfileUpdate',
      'createdAt',
      'updatedAt',
      // A repeater with its own editor, not a scalar form field. Out of v1.
      'workExperience',
    ],
  };

export const EMPLOYEE_BOUND_COLUMNS: BoundColumn[] = [
  // ── employees: locked core ────────────────────────────────────────────────
  {
    fieldKey: 'employeeCode',
    table: 'employee',
    column: 'employeeCode',
    type: 'TEXT',
    systemRequired: true,
    locked: true,
    reason:
      'Primary business key: payroll, WPS wage files, attendance sync and bulk import all match on it.',
  },
  {
    fieldKey: 'fullName',
    table: 'employee',
    column: 'fullName',
    type: 'TEXT',
    systemRequired: true,
    locked: true,
    reason:
      'Written into WPS wage files and cross-checked against the bank account holder name; a mismatch makes the bank reject the whole file.',
  },
  {
    fieldKey: 'dateOfBirth',
    table: 'employee',
    column: 'dateOfBirth',
    type: 'DATE',
    systemRequired: true,
    locked: true,
    reason: 'NOT NULL, and statutory age checks depend on it.',
  },
  {
    fieldKey: 'idCard',
    table: 'employee',
    column: 'idCard',
    type: 'TEXT',
    systemRequired: true,
    locked: true,
    reason: 'Unique constraint; the national identity key for statutory returns.',
  },
  {
    fieldKey: 'email',
    table: 'employee',
    column: 'email',
    type: 'EMAIL',
    systemRequired: true,
    locked: true,
    reason: 'Unique constraint; the login identity and every notification path.',
  },
  {
    fieldKey: 'departmentId',
    table: 'employee',
    column: 'departmentId',
    type: 'DEPARTMENT_SELECT',
    systemRequired: true,
    locked: true,
    reason: 'Foreign key with onDelete: Restrict — the org hierarchy.',
  },
  {
    fieldKey: 'branchId',
    table: 'employee',
    column: 'branchId',
    type: 'BRANCH_SELECT',
    // Nullable today; set NOT NULL in the branch backfill Phase 4 (migration C).
    systemRequired: false,
    locked: true,
    reason:
      'The branch isolation axis. Every scoped query filters on it — hiding it would let a record be created invisible to its own branch.',
  },
  {
    fieldKey: 'position',
    table: 'employee',
    column: 'position',
    type: 'LIBRARY_SELECT',
    systemRequired: true,
    locked: true,
    optionSource: 'POSITION',
    reason: 'NOT NULL, and templated into offer/employment letters.',
  },
  {
    fieldKey: 'startDate',
    table: 'employee',
    column: 'startDate',
    type: 'DATE',
    systemRequired: true,
    locked: true,
    reason:
      'Drives gratuity, leave accrual and proration in every payroll run.',
  },
  {
    fieldKey: 'baseSalary',
    table: 'employee',
    column: 'baseSalary',
    type: 'CURRENCY',
    systemRequired: true,
    locked: true,
    reason:
      'Payroll earnings and the overtime hourly rate. Decimal(12,2) — must stay a typed column, never JSON.',
  },
  {
    fieldKey: 'status',
    table: 'employee',
    column: 'status',
    type: 'SELECT',
    systemRequired: false, // NOT NULL but defaults to 'ACTIVE'
    locked: true,
    reason:
      'Selects who is included in a payroll run and who can log in. Lifecycle state, not profile data.',
  },
  {
    fieldKey: 'salaryType',
    table: 'employee',
    column: 'salaryType',
    type: 'SELECT',
    systemRequired: false, // NOT NULL but defaults to 'MONTHLY'
    locked: true,
    reason:
      'Pay basis (MONTHLY | DAILY). Chooses the payroll earnings formula and the overtime hourly rate.',
  },
  {
    fieldKey: 'employmentType',
    table: 'employee',
    column: 'employmentType',
    type: 'LIBRARY_SELECT',
    systemRequired: false,
    locked: true,
    optionSource: 'EMPLOYMENT_TYPE',
    reason:
      'Derives the pay basis from LibraryItem.payBasis and selects the middle tier of the overtime policy chain.',
  },

  // ── employees: bound but fully admin-controlled ───────────────────────────
  {
    fieldKey: 'gender',
    table: 'employee',
    column: 'gender',
    type: 'SELECT',
    systemRequired: false,
    locked: false,
  },
  {
    fieldKey: 'address',
    table: 'employee',
    column: 'address',
    type: 'TEXTAREA',
    systemRequired: false,
    locked: false,
  },
  {
    fieldKey: 'phone',
    table: 'employee',
    column: 'phone',
    type: 'PHONE',
    systemRequired: false,
    locked: false,
  },
  {
    // Qualifies `phone`: which country's numbering plan it belongs to. Read by
    // the WhatsApp outbox to build an E.164 address, falling back to the branch
    // country when unset — so it is genuinely optional, not locked.
    fieldKey: 'phoneCountryCode',
    table: 'employee',
    column: 'phoneCountryCode',
    type: 'PHONE_COUNTRY',
    systemRequired: false,
    locked: false,
  },
  {
    fieldKey: 'avatarUrl',
    table: 'employee',
    column: 'avatarUrl',
    type: 'FILE',
    systemRequired: false,
    locked: false,
  },
  {
    fieldKey: 'endDate',
    table: 'employee',
    column: 'endDate',
    type: 'DATE',
    systemRequired: false,
    locked: false,
  },
  {
    fieldKey: 'supervisorId',
    table: 'employee',
    column: 'supervisorId',
    type: 'EMPLOYEE_SELECT',
    systemRequired: false,
    locked: false,
  },
  {
    fieldKey: 'overtimePolicyId',
    table: 'employee',
    column: 'overtimePolicyId',
    type: 'SELECT',
    systemRequired: false,
    locked: false,
  },
  {
    fieldKey: 'timezone',
    table: 'employee',
    column: 'timezone',
    type: 'TEXT',
    systemRequired: false,
    locked: false,
  },
  {
    fieldKey: 'dateFormat',
    table: 'employee',
    column: 'dateFormat',
    type: 'SELECT',
    systemRequired: false,
    locked: false,
  },
  {
    fieldKey: 'attendanceExternalId',
    table: 'employee',
    column: 'attendanceExternalId',
    type: 'TEXT',
    systemRequired: false,
    locked: false,
  },

  // ── employee_profiles: personal ──────────────────────────────────────────
  {
    fieldKey: 'placeOfBirth',
    table: 'employeeProfile',
    column: 'placeOfBirth',
    type: 'TEXT',
    systemRequired: false,
    locked: false,
  },
  {
    fieldKey: 'nationality',
    table: 'employeeProfile',
    column: 'nationality',
    type: 'TEXT',
    // NOT NULL, but defaults to 'Vietnam' at the column level, so the template
    // may still make it optional. The VN default is legacy — see plan risk R4.
    systemRequired: false,
    locked: false,
  },
  {
    fieldKey: 'nationalityCode',
    table: 'employeeProfile',
    column: 'nationalityCode',
    type: 'TEXT',
    // ISO-3166 alpha-2, uppercase, CHECK-enforced. Bound rather than excluded
    // because end-of-service benefit is calculated from it and somebody has to
    // be able to record it; the free-text `nationality` above cannot drive a
    // statutory rule.
    systemRequired: false,
    locked: false,
  },
  {
    fieldKey: 'nationalityClass',
    table: 'employeeProfile',
    column: 'nationalityClass',
    type: 'SELECT',
    // NATIONAL | GCC | EXPAT. Left optional at the template level, because NULL
    // is meaningful here: gratuity refuses to accrue for an employee whose class
    // nobody has recorded rather than guessing at a statutory entitlement, and
    // forcing a value on every existing employee would replace "unknown" with a
    // guess on the day this shipped.
    systemRequired: false,
    locked: false,
  },
  {
    fieldKey: 'ethnicity',
    table: 'employeeProfile',
    column: 'ethnicity',
    type: 'TEXT',
    systemRequired: false,
    locked: false,
  },
  {
    fieldKey: 'religion',
    table: 'employeeProfile',
    column: 'religion',
    type: 'TEXT',
    systemRequired: false,
    locked: false,
  },
  {
    fieldKey: 'maritalStatus',
    table: 'employeeProfile',
    column: 'maritalStatus',
    type: 'SELECT',
    systemRequired: false,
    locked: false,
  },
  {
    fieldKey: 'numberOfChildren',
    table: 'employeeProfile',
    column: 'numberOfChildren',
    type: 'NUMBER',
    systemRequired: false, // NOT NULL but defaults to 0
    locked: false,
  },

  // ── employee_profiles: address ───────────────────────────────────────────
  {
    fieldKey: 'permanentAddress',
    table: 'employeeProfile',
    column: 'permanentAddress',
    type: 'TEXTAREA',
    systemRequired: false,
    locked: false,
  },
  {
    fieldKey: 'temporaryAddress',
    table: 'employeeProfile',
    column: 'temporaryAddress',
    type: 'TEXTAREA',
    systemRequired: false,
    locked: false,
  },

  // ── employee_profiles: government IDs ────────────────────────────────────
  {
    fieldKey: 'passportNumber',
    table: 'employeeProfile',
    column: 'passportNumber',
    type: 'TEXT',
    systemRequired: false,
    locked: false,
  },
  {
    fieldKey: 'passportExpiry',
    table: 'employeeProfile',
    column: 'passportExpiry',
    type: 'DATE',
    systemRequired: false,
    locked: false,
  },

  // ── employee_profiles: emergency contact ─────────────────────────────────
  {
    fieldKey: 'emergencyContactName',
    table: 'employeeProfile',
    column: 'emergencyContactName',
    type: 'TEXT',
    systemRequired: false,
    locked: false,
  },
  {
    fieldKey: 'emergencyContactRelationship',
    table: 'employeeProfile',
    column: 'emergencyContactRelationship',
    type: 'SELECT',
    systemRequired: false,
    locked: false,
  },
  {
    fieldKey: 'emergencyContactPhone',
    table: 'employeeProfile',
    column: 'emergencyContactPhone',
    type: 'PHONE',
    systemRequired: false,
    locked: false,
  },
  {
    fieldKey: 'emergencyContactAddress',
    table: 'employeeProfile',
    column: 'emergencyContactAddress',
    type: 'TEXTAREA',
    systemRequired: false,
    locked: false,
  },

  // ── employee_profiles: education ─────────────────────────────────────────
  {
    fieldKey: 'highestEducation',
    table: 'employeeProfile',
    column: 'highestEducation',
    type: 'SELECT',
    systemRequired: false,
    locked: false,
  },
  {
    fieldKey: 'major',
    table: 'employeeProfile',
    column: 'major',
    type: 'TEXT',
    systemRequired: false,
    locked: false,
  },
  {
    fieldKey: 'university',
    table: 'employeeProfile',
    column: 'university',
    type: 'TEXT',
    systemRequired: false,
    locked: false,
  },
  {
    fieldKey: 'graduationYear',
    table: 'employeeProfile',
    column: 'graduationYear',
    type: 'NUMBER',
    systemRequired: false,
    locked: false,
  },
  {
    fieldKey: 'professionalCertificates',
    table: 'employeeProfile',
    column: 'professionalCertificates',
    type: 'TEXTAREA',
    systemRequired: false,
    locked: false,
  },

  // ── employee_profiles: legacy bank ───────────────────────────────────────
  // Superseded by EmployeeBankDetail (versioned, country-aware, WPS-facing).
  // Kept bound so historic values stay visible; expect admins to deactivate them.
  {
    fieldKey: 'bankName',
    table: 'employeeProfile',
    column: 'bankName',
    type: 'TEXT',
    systemRequired: false,
    locked: false,
  },
  {
    fieldKey: 'bankAccountNumber',
    table: 'employeeProfile',
    column: 'bankAccountNumber',
    type: 'TEXT',
    systemRequired: false,
    locked: false,
  },
  {
    fieldKey: 'bankAccountHolderName',
    table: 'employeeProfile',
    column: 'bankAccountHolderName',
    type: 'TEXT',
    systemRequired: false,
    locked: false,
  },
  {
    fieldKey: 'bankBranch',
    table: 'employeeProfile',
    column: 'bankBranch',
    type: 'TEXT',
    systemRequired: false,
    locked: false,
  },

  // ── employee_profiles: insurance & tax ───────────────────────────────────
  {
    fieldKey: 'taxCode',
    table: 'employeeProfile',
    column: 'taxCode',
    type: 'TEXT',
    systemRequired: false,
    locked: false,
  },
  {
    fieldKey: 'socialInsuranceNumber',
    table: 'employeeProfile',
    column: 'socialInsuranceNumber',
    type: 'TEXT',
    systemRequired: false,
    locked: false,
  },
  {
    fieldKey: 'healthInsuranceNumber',
    table: 'employeeProfile',
    column: 'healthInsuranceNumber',
    type: 'TEXT',
    systemRequired: false,
    locked: false,
  },
  {
    fieldKey: 'dependents',
    table: 'employeeProfile',
    column: 'dependents',
    type: 'NUMBER',
    systemRequired: false,
    locked: false,
  },
];

/** Lookup by template key. Built once — this is read on every employee write. */
export const BOUND_BY_KEY: ReadonlyMap<string, BoundColumn> = new Map(
  EMPLOYEE_BOUND_COLUMNS.map((c) => [c.fieldKey, c]),
);

/** True when the key maps onto a real column rather than the JSONB bag. */
export function isBoundField(fieldKey: string): boolean {
  return BOUND_BY_KEY.has(fieldKey);
}

/** The fields an admin may never deactivate, for the builder's lock icons. */
export const LOCKED_FIELD_KEYS: readonly string[] = EMPLOYEE_BOUND_COLUMNS.filter(
  (c) => c.locked,
).map((c) => c.fieldKey);

/** A field the caller is allowed to write, as resolved from the template. */
export interface StorageRoutable {
  fieldKey: string;
}

export interface SplitValues {
  /** Patch for `prisma.employee`, keyed by Prisma field name. */
  employee: Record<string, unknown>;
  /** Patch for `prisma.employeeProfile`, keyed by Prisma field name. */
  profile: Record<string, unknown>;
  /** Merge into `employees.custom_fields`, keyed by template fieldKey. */
  custom: Record<string, unknown>;
}

/**
 * Route submitted values to their storage. Only keys present in BOTH the
 * submitted map and the resolved template are routed — an unknown key is the
 * caller's problem to reject (see validateDynamicData), and a template field the
 * caller omitted must stay untouched rather than being written as undefined.
 */
export function splitByStorage(
  values: Record<string, unknown>,
  fields: readonly StorageRoutable[],
): SplitValues {
  const out: SplitValues = { employee: {}, profile: {}, custom: {} };
  for (const f of fields) {
    if (!Object.prototype.hasOwnProperty.call(values, f.fieldKey)) continue;
    const bound = BOUND_BY_KEY.get(f.fieldKey);
    if (!bound) {
      out.custom[f.fieldKey] = values[f.fieldKey];
      continue;
    }
    const target = bound.table === 'employee' ? out.employee : out.profile;
    target[bound.column] = values[f.fieldKey];
  }
  return out;
}

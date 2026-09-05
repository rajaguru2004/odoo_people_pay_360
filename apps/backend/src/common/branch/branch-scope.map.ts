/**
 * Registry: how each Prisma model is branch-scoped.
 *   'direct'      -> the model has its own `branchId` column.
 *   'direct-or-global' -> own `branchId` column, but NULL means "every branch".
 *                    Needed wherever a row can be company-wide: a plain
 *                    `branchId IN (...)` never matches NULL in SQL, so such a
 *                    row would be invisible from every branch — which is
 *                    exactly how a company-wide training session vanished the
 *                    moment it was created.
 *   'relation'    -> scoped through its `employee` relation
 *                    (i.e. `where.employee.branchId`). Sugar for `{ path: ['employee'] }`.
 *   { path: [...] }-> scoped through a nested to-one relation chain ending at a
 *                    model that carries `branchId`, e.g. `['contract','employee']`
 *                    => `where.contract.employee.branchId`. Every segment must be
 *                    a to-one relation field (verified against schema.prisma).
 *
 * Models not listed are NOT branch-scoped (Department, Team, User, SystemSetting,
 * project/task tracker, etc.). Keyed by Prisma model name (`params.model`).
 */
export type BranchScopeRule =
  | 'direct'
  | 'direct-or-global'
  | 'relation'
  | { path: string[] };

export const BRANCH_SCOPE: Record<string, BranchScopeRule> = {
  // Own branchId column
  Employee: 'direct',
  Attendance: 'direct',
  Payroll: 'direct', // per-branch payroll (branchId added via migration)
  PayrollBatch: 'direct', // per-branch payroll batches
  AttendanceIntegration: 'direct', // external attendance provider wired to a branch
  AssetItem: 'direct', // assets belong to the branch that holds them
  // Sessions may be branch-specific or open to all (branchId null). A null
  // branchId is intentionally NOT filtered out — a company-wide session must
  // stay visible to every branch.
  // A session with no branch is open to the whole company, so NULL must read as
  // "visible everywhere" rather than "visible nowhere".
  TrainingSession: 'direct-or-global',
  // The COMPANY template carries branch_id NULL and is the fallback every
  // branch resolves to when it has no override of its own. Plain 'direct' would
  // hide it from every branch and leave the employee form with no fields at all.
  ProfileTemplate: 'direct-or-global',
  // Document engine. Same reasoning as ProfileTemplate directly above: the
  // COMPANY row carries branch_id NULL and is what a branch with no override of
  // its own resolves to. Plain 'direct' would hide the company letterhead and
  // the company template from every branch, and the symptom would be "documents
  // suddenly have no template" rather than anything naming branches.
  DocumentTemplate: 'direct-or-global',
  DocumentAsset: 'direct-or-global',
  DocumentSignatory: 'direct-or-global',
  // Issued BY a branch, and NOT NULL — so plain 'direct' is right and there is
  // no company-wide row to hide. Deliberately not scoped through the employee:
  // a transfer afterwards must not retroactively move a document that has
  // already gone to a bank. Same reasoning as FinalSettlement.
  GeneratedDocument: 'direct',
  DocumentBatch: 'direct',

  // Scoped via employee.branchId
  Contract: 'relation',
  AttendanceCorrection: 'relation',
  LeaveRequest: 'relation',
  LeaveBalance: 'relation',
  LeaveTypeBalance: 'relation',
  LeaveAccrualHistory: 'relation',
  OvertimeRequest: 'relation',
  Reward: 'relation',
  Discipline: 'relation',
  SalaryComponent: 'relation',
  PayrollItem: 'relation',
  Timesheet: 'relation',
  WorkLog: 'relation',
  WorkSchedule: 'relation',
  EmployeeActivity: 'relation',
  EmployeeHistory: 'relation',
  EmployeeProfile: 'relation',
  EmployeeDocument: 'relation',
  FaceDescriptor: 'relation',
  // The carry-forward ledger DOES carry a branchId: the run that opened the
  // balance belonged to one branch, and a branch-scoped payroll officer must
  // see what their own runs left owing.
  PayrollCarryForward: 'direct',
  // A payslip line is scoped by the payslip it explains, which is scoped by the
  // employee. Going through `item.employee` rather than denormalising a branchId
  // means a line can never disagree with the payslip it belongs to.
  PayrollItemLine: { path: ['item', 'employee'] },
  // NULL branchId is the deliberate company-wide default and must stay readable
  // from every branch, so 'direct' alone would hide it everywhere at once.
  LeaveTypePolicy: 'direct-or-global',
  LeaveCarryForwardRun: 'direct',
  PayrollBatchMember: 'relation',
  EmployeeLegalDocument: 'relation',
  // Scoped by the HOLDER, not the asset's branch: an asset lent across branches
  // is still the holder's clearance obligation.
  AssetAssignment: 'relation',
  TrainingNomination: 'relation',
  LetterRequest: 'relation',
  Grievance: 'relation',

  TerminationRequest: { path: ['contract', 'employee'] },
  ContractAppendix: { path: ['contract', 'employee'] },
  LeaveApproval: { path: ['leaveRequest', 'employee'] },
  // Same path as its sibling above. Its absence was an omission, not a design:
  // leave attachments are medical certificates, and without this rule a
  // branch-scoped caller could list and upload them for a leave request whose
  // parent record they are correctly refused.
  LeaveAttachment: { path: ['leaveRequest', 'employee'] },
  GrievanceEvent: { path: ['grievance', 'employee'] },
  LegalDocumentAttachment: { path: ['legalDocument', 'employee'] },
  AttendanceSyncRun: { path: ['integration'] },
  // Scoped through the template so a section/field is exactly as visible as the
  // template owning it — including the company template's NULL branch_id, which
  // `direct-or-global` on the parent already resolves correctly.
  ProfileTemplateSection: { path: ['template'] },
  ProfileTemplateField: { path: ['template'] },
  // Scoped through their parent so a version can never disagree with the
  // template it belongs to, and a batch item never with its batch.
  DocumentTemplateVersion: { path: ['template'] },
  DocumentBatchItem: { path: ['batch'] },
  // WpsEmployerProfile is deliberately NOT scoped — one Ministry registration may
  // cover several branches. It is reachable only via ADMIN endpoints and via the
  // branch-scoped WpsConfiguration that points at it.
};

/**
 * Read actions whose `where` accepts full filters (incl. relation predicates).
 * We AND-compose the branch predicate into these for every rule type.
 */
export const BRANCH_READ_ACTIONS = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'count',
  'aggregate',
  'groupBy',
]);

/**
 * Bulk-write actions whose `where` is SCALAR-ONLY in Prisma — a relation/path
 * predicate throws. We only auto-scope these for `direct` models; relation/path
 * models must guard bulk writes via a preceding `assertInBranch` at the service.
 */
export const BRANCH_WRITE_MANY_ACTIONS = new Set(['updateMany', 'deleteMany']);

/**
 * Build the Prisma `where` fragment that restricts to the given branch ids.
 * `null`/empty ids => an impossible match (`{ in: [] }`) so a scoped caller with
 * no accessible branches sees nothing (fail-closed), never everything.
 * For `{ path }`, folds the chain from the innermost `branchId` outward:
 *   ['contract','employee'] -> { contract: { employee: { branchId: { in } } } }
 */
export function buildBranchWhere(
  rule: BranchScopeRule,
  ids: string[],
): Record<string, unknown> {
  const leaf: Record<string, unknown> = { branchId: { in: ids } };
  if (rule === 'direct') return leaf;
  // NULL is not comparable with IN, so a company-wide row needs an explicit
  // arm — without it, `branchId IS NULL` matches nothing and the row is
  // invisible to every caller.
  if (rule === 'direct-or-global') {
    return { OR: [{ branchId: { in: ids } }, { branchId: null }] };
  }
  const path = rule === 'relation' ? ['employee'] : rule.path;
  return path.reduceRight<Record<string, unknown>>(
    (acc, segment) => ({ [segment]: acc }),
    leaf,
  );
}

/** True when the rule scopes via a scalar `branchId` column on the model itself. */
export function isDirectRule(rule: BranchScopeRule): boolean {
  return rule === 'direct';
}

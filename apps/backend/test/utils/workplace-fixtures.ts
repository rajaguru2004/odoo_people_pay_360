import * as bcrypt from 'bcrypt';
import { E2EContext } from './e2e-app';
import { Fixtures, setupFixtures } from './fixtures';

/**
 * The Workplace phase's fixture set — Asset Register and Letter Requests.
 *
 * LAYERED on `utils/fixtures.ts` rather than replacing it. That base already
 * builds the exact tenancy skeleton these three modules are asserted against —
 * two branches, a global ADMIN, a **branch-A-scoped** HR_MANAGER and a plain
 * EMPLOYEE — and its `cleanup()` already knows the awkward edges (audit rows
 * pinned to a user). Rebuilding that here would mean re-deriving those lessons.
 *
 * What the base cannot give, and this file adds:
 *
 *  1. **Custody states, not just assets.** Clearance is keyed on
 *     `returnedAt IS NULL`, never on `Employee.status`, so the set needs an
 *     ACTIVE holder AND an INACTIVE leaver who still holds something — the
 *     shape the outstanding report exists to surface. It also needs an asset
 *     whose history is CLOSED, because `AssetAssignment.assetId` is
 *     `onDelete: Cascade`: deleting a returned asset erases the evidence a past
 *     clearance was granted (plan finding R3), and that is only provable
 *     against a returned assignment that already exists.
 *  2. **A MANAGER with a real department boundary.** `/assets/assignments/open`
 *     narrows a MANAGER to `managedDepartmentIds`, so one employee inside the
 *     headed department and one outside it are both required — with only one,
 *     a narrowing bug and a working filter look identical.
 *  3. **Templates in all four interesting states.** `requiresApproval:false`
 *     collapses request+issue inline (R4); `isActive:false` is refused by
 *     `request()` but NOT by `issue()` (R14); locale `ar` proves the
 *     `@@unique([key, locale])` pairing is a real dimension and not decoration.
 *  4. **A `isSensitive` profile-template field.** `customLetterFields()` drops
 *     sensitive fields OUTRIGHT rather than masking them. A fixture with only
 *     ordinary fields cannot tell "excluded" from "there was nothing to
 *     exclude". Note the consumer spec must flip `employee_profile_template_enabled`
 *     on (via `withSetting`) for the resolver to look at these rows at all.
 *
 * Everything is tagged with the base `runId` — deliberately the SAME tag, not a
 * second one, so the base `cleanup()` still recognises every employee and user
 * this file adds and the two teardowns cannot drift apart.
 */

const PASSWORD = 'Passw0rd!';

export interface WorkplaceUser {
  userId: string;
  employeeId?: string;
  email: string;
  token: string;
}

export interface WorkplaceFixtures {
  /** Shared with the base fixtures — every row this file writes carries it. */
  runId: string;
  password: string;

  /** The base set, so a spec can still reach `empAId`, `plainEmployee`, etc. */
  base: Fixtures;

  // ── Organization ─────────────────────────────────────────────────────────
  branchA: string;
  branchAcode: string;
  branchB: string;
  branchBcode: string;
  /** Department `manager` heads. Holds holder, leaver and `managedEmployeeId`. */
  managedDeptId: string;
  managedDeptCode: string;
  /** Department `manager` does NOT head. Holds `unmanagedEmployeeId`. */
  otherDeptId: string;
  otherDeptCode: string;

  // ── Employees ────────────────────────────────────────────────────────────
  /** ACTIVE, in the managed department, holds `assetHeldAId` (open). */
  holderId: string;
  /** INACTIVE, in the managed department, STILL holds `assetLeaverHeldId`. */
  leaverId: string;
  /** ACTIVE, in the department the MANAGER heads. Holds nothing. */
  managedEmployeeId: string;
  /** ACTIVE, in a department the MANAGER does not head. Holds nothing. */
  unmanagedEmployeeId: string;
  /** The MANAGER's own employee row. Heads `managedDept`. */
  managerEmployeeId: string;
  /** ACTIVE, branch B — the subject every cross-branch case needs. */
  branchBEmployeeId: string;

  /** ACTIVE, a real login, unrelated to `holderId`/`leaverId`. */
  colleagueEmployeeId: string;
  /** ACTIVE, a real login, a second unrelated employee. */
  outsiderEmployeeId: string;

  // ── Users ────────────────────────────────────────────────────────────────
  /** Global ADMIN (from the base set). */
  admin: WorkplaceUser;
  /** HR_MANAGER scoped to branch A only (from the base set). */
  scopedHr: WorkplaceUser;
  /** Plain EMPLOYEE bound to `base.empAId` (from the base set). */
  employee: WorkplaceUser;
  /** MANAGER heading `managedDept`. */
  manager: WorkplaceUser;

  /** EMPLOYEE, a real login, standing in for "some other employee" in RBAC checks. */
  colleague: WorkplaceUser;
  /** MANAGER, a real login, a second unrelated principal for the same purpose. */
  outsider: WorkplaceUser;

  // ── Assets ───────────────────────────────────────────────────────────────
  /** Branch A, AVAILABLE, never assigned. */
  assetAvailableAId: string;
  assetAvailableATag: string;
  /** Branch A, ASSIGNED — open assignment held by `holderId`. */
  assetHeldAId: string;
  assetHeldATag: string;
  /** Branch A, ASSIGNED — open assignment held by the INACTIVE `leaverId`. */
  assetLeaverHeldId: string;
  assetLeaverHeldTag: string;
  /** Branch A, AVAILABLE, with ONE closed (returned) assignment behind it. */
  assetClosedHistoryAId: string;
  assetClosedHistoryATag: string;
  /** Branch B, AVAILABLE — invisible to the branch-A-scoped HR. */
  assetAvailableBId: string;
  assetAvailableBTag: string;

  /** Open assignment rows. */
  openAssignmentHolderId: string;
  openAssignmentLeaverId: string;
  /** The returned assignment `assetClosedHistoryAId` cascades away with. */
  closedAssignmentId: string;

  // ── Letter templates ─────────────────────────────────────────────────────
  /** requiresApproval TRUE, locale 'en', active. The HR-queue path. */
  tplApprovalKey: string;
  tplApprovalId: string;
  /** requiresApproval FALSE, locale 'en', active. Auto-issues inside request(). */
  tplAutoIssueKey: string;
  tplAutoIssueId: string;
  /** Same key as `tplApprovalKey`, locale 'ar' — the second half of the pair. */
  tplArabicKey: string;
  tplArabicLocale: string;
  tplArabicId: string;
  /** isActive FALSE. request() 404s on it; issue() does not look at isActive. */
  tplInactiveKey: string;
  tplInactiveId: string;

  // ── Profile template (letter context) ────────────────────────────────────
  profileTemplateId: string;
  profileSectionId: string;
  /** JSONB, active, NOT sensitive — must appear in `custom.*`. */
  visibleFieldKey: string;
  visibleFieldId: string;
  /** JSONB, active, isSensitive TRUE — must be absent from `custom.*` entirely. */
  sensitiveFieldKey: string;
  sensitiveFieldId: string;

  cleanup: () => Promise<void>;
}

async function login(ctx: E2EContext, email: string): Promise<string> {
  const res = await ctx
    .http()
    .post('/auth/login')
    .send({ email, password: PASSWORD });
  if (!res.body?.data?.accessToken) {
    throw new Error(
      `login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`,
    );
  }
  return res.body.data.accessToken;
}

const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
};

/** Letter template keys are short VarChar columns; the full runId does not fit beside a prefix. */
const shortTag = (runId: string) => runId.slice(-8);

export async function setupWorkplaceFixtures(
  ctx: E2EContext,
): Promise<WorkplaceFixtures> {
  const { prisma } = ctx;
  const base = await setupFixtures(ctx);
  const runId = base.runId;
  const short = shortTag(runId);
  const hash = await bcrypt.hash(PASSWORD, 10);

  // ── Departments ───────────────────────────────────────────────────────────
  const managedDeptCode = `WPL-MGD-${runId}`;
  const otherDeptCode = `WPL-OTH-${runId}`;
  const managedDept = await prisma.department.create({
    data: { code: managedDeptCode, name: `WPL Managed ${runId}`, isActive: true },
  });
  const otherDept = await prisma.department.create({
    data: { code: otherDeptCode, name: `WPL Other ${runId}`, isActive: true },
  });

  // ── Employees ─────────────────────────────────────────────────────────────
  const mkEmployee = (
    suffix: string,
    over: Record<string, unknown> = {},
  ): any => ({
    employeeCode: `EMP-${runId}-${suffix}`,
    fullName: `WPL ${suffix}`,
    dateOfBirth: new Date('1992-05-05'),
    idCard: `ID-${runId}-${suffix}`,
    email: `${suffix.toLowerCase()}-${runId}@test.local`,
    departmentId: managedDept.id,
    branchId: base.branchA,
    position: 'Engineer',
    startDate: new Date('2024-01-01'),
    baseSalary: 55000,
    status: 'ACTIVE',
    ...over,
  });

  const holderEmp = await prisma.employee.create({
    data: mkEmployee('HOLDER', {
      // Values the letter render reads through the template fields below.
      customFields: { [`grade${short}`]: 'G7', [`secret${short}`]: '999.000' },
    }),
  });
  const leaverEmp = await prisma.employee.create({
    data: mkEmployee('LEAVER', { status: 'INACTIVE' }),
  });
  const managedEmp = await prisma.employee.create({ data: mkEmployee('MANAGED') });
  const unmanagedEmp = await prisma.employee.create({
    data: mkEmployee('UNMANAGED', { departmentId: otherDept.id }),
  });
  const managerEmp = await prisma.employee.create({
    data: mkEmployee('MGRHEAD', { position: 'Head of WPL Managed' }),
  });
  const branchBEmp = await prisma.employee.create({
    data: mkEmployee('BRANCHB', { branchId: base.branchB }),
  });

  const colleagueEmp = await prisma.employee.create({
    data: mkEmployee('COLLEAGUE', { departmentId: otherDept.id }),
  });
  const outsiderEmp = await prisma.employee.create({
    data: mkEmployee('OUTSIDER', { departmentId: otherDept.id }),
  });

  // The headship is what `managedDepartmentIds` resolves from — without it the
  // MANAGER narrows to the empty set and every scoping case passes vacuously.
  await prisma.department.update({
    where: { id: managedDept.id },
    data: { managerId: managerEmp.id },
  });

  // ── Users ─────────────────────────────────────────────────────────────────
  const mkUser = (
    suffix: string,
    role: string,
    over: Record<string, any> = {},
  ) =>
    prisma.user.create({
      data: {
        email: `${suffix.toLowerCase()}-${runId}@test.local`,
        passwordHash: hash,
        role,
        isActive: true,
        isGlobalBranchAccess: true,
        ...over,
      },
    });

  const managerUser = await mkUser('WPLMGR', 'MANAGER', {
    employeeId: managerEmp.id,
  });
  const colleagueUser = await mkUser('WPLCOLL', 'EMPLOYEE', {
    employeeId: colleagueEmp.id,
    isGlobalBranchAccess: false,
  });
  const outsiderUser = await mkUser('WPLOUT', 'MANAGER', {
    employeeId: outsiderEmp.id,
  });

  // ── Assets ────────────────────────────────────────────────────────────────
  const mkAsset = (
    suffix: string,
    over: Record<string, unknown> = {},
  ): any => ({
    assetTag: `AST-${runId}-${suffix}`,
    category: 'Laptop',
    name: `WPL Asset ${suffix}`,
    serialNumber: `SN-${runId}-${suffix}`,
    branchId: base.branchA,
    status: 'AVAILABLE',
    purchaseDate: new Date('2025-01-15'),
    purchaseCost: 1200,
    warrantyExpiry: new Date('2028-01-15'),
    ...over,
  });

  const assetAvailableA = await prisma.assetItem.create({ data: mkAsset('A1') });
  const assetHeldA = await prisma.assetItem.create({
    data: mkAsset('A2', { status: 'ASSIGNED' }),
  });
  const assetLeaverHeld = await prisma.assetItem.create({
    data: mkAsset('A3', { status: 'ASSIGNED' }),
  });
  const assetClosedHistoryA = await prisma.assetItem.create({
    data: mkAsset('A4'),
  });
  const assetAvailableB = await prisma.assetItem.create({
    data: mkAsset('B1', { branchId: base.branchB }),
  });

  // `assignedById` is RESTRICT on User, so cleanup must clear assignments
  // before the base clears users — which is exactly the order below.
  const openAssignmentHolder = await prisma.assetAssignment.create({
    data: {
      assetId: assetHeldA.id,
      employeeId: holderEmp.id,
      assignedAt: daysAgo(30),
      assignedById: base.globalAdmin.userId,
      conditionOut: 'GOOD',
    },
  });
  const openAssignmentLeaver = await prisma.assetAssignment.create({
    data: {
      assetId: assetLeaverHeld.id,
      employeeId: leaverEmp.id,
      assignedAt: daysAgo(60),
      assignedById: base.globalAdmin.userId,
      conditionOut: 'GOOD',
    },
  });
  // Closed history. The partial unique index `asset_assignments_one_open_per_asset`
  // only tolerates this row beside a future open one because `returnedAt` is set.
  const closedAssignment = await prisma.assetAssignment.create({
    data: {
      assetId: assetClosedHistoryA.id,
      employeeId: holderEmp.id,
      assignedAt: daysAgo(120),
      assignedById: base.globalAdmin.userId,
      conditionOut: 'GOOD',
      returnedAt: daysAgo(90),
      conditionIn: 'GOOD',
      returnReceivedById: base.globalAdmin.userId,
    },
  });

  // ── Letter templates ──────────────────────────────────────────────────────
  const body = (title: string) =>
    `<html><body><h1>${title}</h1>` +
    `<p>{{employeeName}} ({{employeeCode}}) — {{position}}</p>` +
    `<p>Serial: {{serialNumber}} / {{issueDate}}</p>` +
    `<p>Grade: {{custom.grade${short}}}</p>` +
    `<p>Secret: {{custom.secret${short}}}</p>` +
    `</body></html>`;

  const tplApprovalKey = `WPLAPP-${short}`;
  const tplAutoIssueKey = `WPLAUTO-${short}`;
  const tplInactiveKey = `WPLOFF-${short}`;

  const tplApproval = await prisma.letterTemplate.create({
    data: {
      key: tplApprovalKey,
      name: `WPL Approval Letter ${short}`,
      locale: 'en',
      bodyHtml: body('WPL Approval Letter'),
      requiresApproval: true,
      isActive: true,
    },
  });
  const tplAutoIssue = await prisma.letterTemplate.create({
    data: {
      key: tplAutoIssueKey,
      name: `WPL Auto Issue Letter ${short}`,
      locale: 'en',
      bodyHtml: body('WPL Auto Issue Letter'),
      requiresApproval: false,
      isActive: true,
    },
  });
  // Same KEY, different LOCALE — the pair the @@unique([key, locale]) exists for.
  const tplArabic = await prisma.letterTemplate.create({
    data: {
      key: tplApprovalKey,
      name: `WPL خطاب ${short}`,
      locale: 'ar',
      bodyHtml: `<html><body dir="rtl"><h1>شهادة</h1><p>{{employeeName}}</p><p>{{serialNumber}}</p></body></html>`,
      requiresApproval: true,
      isActive: true,
    },
  });
  const tplInactive = await prisma.letterTemplate.create({
    data: {
      key: tplInactiveKey,
      name: `WPL Retired Letter ${short}`,
      locale: 'en',
      bodyHtml: body('WPL Retired Letter'),
      requiresApproval: true,
      isActive: false,
    },
  });

  // ── Profile template driving the letter's `custom.*` context ──────────────
  const visibleFieldKey = `grade${short}`;
  const sensitiveFieldKey = `secret${short}`;
  const profileTemplate = await prisma.profileTemplate.create({
    data: {
      scope: 'BRANCH',
      branchId: base.branchA,
      name: `WPL Letter Template ${runId}`,
      isActive: true,
    },
  });
  const profileSection = await prisma.profileTemplateSection.create({
    data: {
      templateId: profileTemplate.id,
      sectionKey: 'wpl_letter',
      label: 'WPL Letter Fields',
      wizardStep: 1,
      displayOrder: 90,
      isActive: true,
      origin: 'CUSTOM',
    },
  });
  const visibleField = await prisma.profileTemplateField.create({
    data: {
      templateId: profileTemplate.id,
      sectionId: profileSection.id,
      fieldKey: visibleFieldKey,
      label: 'Job Grade',
      fieldType: 'TEXT',
      storage: 'JSONB',
      isActive: true,
      isSensitive: false,
      displayOrder: 1,
      origin: 'CUSTOM',
    },
  });
  const sensitiveField = await prisma.profileTemplateField.create({
    data: {
      templateId: profileTemplate.id,
      sectionId: profileSection.id,
      fieldKey: sensitiveFieldKey,
      label: 'Confidential Allowance',
      fieldType: 'TEXT',
      storage: 'JSONB',
      isActive: true,
      // The whole point: `customLetterFields()` must DROP this, not mask it.
      isSensitive: true,
      displayOrder: 2,
      origin: 'CUSTOM',
    },
  });

  const employeeWhere = {
    OR: [
      { employeeCode: { contains: runId } },
      { email: { contains: runId } },
    ],
  };

  return {
    runId,
    password: PASSWORD,
    base,

    branchA: base.branchA,
    branchAcode: base.branchAcode,
    branchB: base.branchB,
    branchBcode: base.branchBcode,
    managedDeptId: managedDept.id,
    managedDeptCode,
    otherDeptId: otherDept.id,
    otherDeptCode,

    holderId: holderEmp.id,
    leaverId: leaverEmp.id,
    managedEmployeeId: managedEmp.id,
    unmanagedEmployeeId: unmanagedEmp.id,
    managerEmployeeId: managerEmp.id,
    branchBEmployeeId: branchBEmp.id,

    colleagueEmployeeId: colleagueEmp.id,
    outsiderEmployeeId: outsiderEmp.id,

    admin: {
      userId: base.globalAdmin.userId,
      email: base.globalAdmin.email,
      token: base.globalAdmin.token,
    },
    scopedHr: {
      userId: base.scopedHr.userId,
      employeeId: base.scopedHr.employeeId,
      email: base.scopedHr.email,
      token: base.scopedHr.token,
    },
    employee: {
      userId: base.plainEmployee.userId,
      employeeId: base.plainEmployee.employeeId,
      email: base.plainEmployee.email,
      token: base.plainEmployee.token,
    },
    manager: {
      userId: managerUser.id,
      employeeId: managerEmp.id,
      email: managerUser.email,
      token: await login(ctx, managerUser.email),
    },
    colleague: {
      userId: colleagueUser.id,
      employeeId: colleagueEmp.id,
      email: colleagueUser.email,
      token: await login(ctx, colleagueUser.email),
    },
    outsider: {
      userId: outsiderUser.id,
      employeeId: outsiderEmp.id,
      email: outsiderUser.email,
      token: await login(ctx, outsiderUser.email),
    },

    assetAvailableAId: assetAvailableA.id,
    assetAvailableATag: assetAvailableA.assetTag,
    assetHeldAId: assetHeldA.id,
    assetHeldATag: assetHeldA.assetTag,
    assetLeaverHeldId: assetLeaverHeld.id,
    assetLeaverHeldTag: assetLeaverHeld.assetTag,
    assetClosedHistoryAId: assetClosedHistoryA.id,
    assetClosedHistoryATag: assetClosedHistoryA.assetTag,
    assetAvailableBId: assetAvailableB.id,
    assetAvailableBTag: assetAvailableB.assetTag,

    openAssignmentHolderId: openAssignmentHolder.id,
    openAssignmentLeaverId: openAssignmentLeaver.id,
    closedAssignmentId: closedAssignment.id,

    tplApprovalKey,
    tplApprovalId: tplApproval.id,
    tplAutoIssueKey,
    tplAutoIssueId: tplAutoIssue.id,
    tplArabicKey: tplApprovalKey,
    tplArabicLocale: 'ar',
    tplArabicId: tplArabic.id,
    tplInactiveKey,
    tplInactiveId: tplInactive.id,

    profileTemplateId: profileTemplate.id,
    profileSectionId: profileSection.id,
    visibleFieldKey,
    visibleFieldId: visibleField.id,
    sensitiveFieldKey,
    sensitiveFieldId: sensitiveField.id,

    /**
     * FK-ordered teardown, children first, and the base's `cleanup()` LAST.
     *
     * The order is dictated by RESTRICT / non-cascading edges, not by
     * tidiness:
     *   - `AssetAssignment.assignedById` is RESTRICT on User, so assignments
     *     must go before the base deletes users.
     *   - `AssetItem.branchId` is RESTRICT on Branch, so assets must go before
     *     the base deletes branches.
     *
     * Everything is matched by id or by the run tag; nothing is matched by a
     * shape a real row could also have.
     */
    cleanup: async () => {
      // Assets: assignments (RESTRICT on the assigning user) before items,
      // items (RESTRICT on branch) before the base clears branches.
      await prisma.assetAssignment.deleteMany({
        where: {
          OR: [
            { asset: { assetTag: { contains: runId } } },
            { employee: employeeWhere },
            { assignedBy: { email: { contains: runId } } },
          ],
        },
      });
      await prisma.assetItem.deleteMany({
        where: {
          OR: [
            { assetTag: { contains: runId } },
            { branchId: { in: [base.branchA, base.branchB] } },
          ],
        },
      });

      // Letters: the issued PDF lands in the vault as an EmployeeDocument,
      // which cascades with the employee — but the request row references the
      // issuing user, so it goes first.
      await prisma.letterRequest.deleteMany({
        where: {
          OR: [
            { employee: employeeWhere },
            { issuedBy: { email: { contains: runId } } },
          ],
        },
      });
      await prisma.letterTemplate.deleteMany({
        where: { key: { contains: short } },
      });

      await prisma.profileTemplateField.deleteMany({
        where: { templateId: profileTemplate.id },
      });
      await prisma.profileTemplateSection.deleteMany({
        where: { templateId: profileTemplate.id },
      });
      await prisma.profileTemplate.deleteMany({
        where: { id: profileTemplate.id },
      });

      await prisma.auditLog.deleteMany({
        where: { user: { email: { contains: runId } } },
      });

      // Headships pin an employee the base is about to delete.
      await prisma.department.updateMany({
        where: { code: { contains: runId } },
        data: { managerId: null },
      });

      await base.cleanup();
    },
  };
}

export { bearer } from './settings';

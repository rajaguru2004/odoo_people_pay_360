import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { seedLibraryDefaults } from '../src/library-items/library-defaults';
import { ensureCompanyTemplate } from '../src/profile-templates/profile-template-defaults';
import { backfillScheduleTimezone } from './backfill-schedule-timezone';

const prisma = new PrismaClient();

/** A day rate above this is almost certainly a monthly figure left un-re-entered. */
const SUSPICIOUS_DAY_RATE = 5000;

/**
 * Make each employee's pay basis agree with the employment type they are
 * assigned to, and report every change.
 *
 * The EMPLOYMENT_TYPE library item is the source of truth for pay basis (its
 * `payBasis` flag), but an environment deployed with `prisma db push` never runs
 * migration 20260729120000, which is what performs this convergence elsewhere.
 * Without it a "Daily Wage" employee stays on MONTHLY and their PER-DAY rate is
 * paid as a whole month's salary — the exact defect the flag exists to prevent.
 *
 * Idempotent: after the first run there is nothing left to converge. Every
 * change writes an `employee_history` row, because flipping the basis
 * re-interprets `baseSalary`.
 */
async function convergePayBasis() {
  const flagged = await prisma.libraryItem.findMany({
    where: { libraryType: 'EMPLOYMENT_TYPE', payBasis: { not: null } },
    select: { label: true, payBasis: true },
  });
  if (flagged.length === 0) return;

  // employee_history.changed_by is a NOT NULL uuid with no FK, so the oldest
  // admin stands in for "the system". No admin yet => nothing to converge.
  const admin = await prisma.user.findFirst({
    where: { role: 'ADMIN' },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!admin) return;

  for (const type of flagged) {
    const drifted = await prisma.employee.findMany({
      where: {
        employmentType: type.label,
        NOT: { salaryType: type.payBasis! },
      },
      select: {
        id: true,
        employeeCode: true,
        fullName: true,
        salaryType: true,
        baseSalary: true,
      },
    });
    if (drifted.length === 0) continue;

    console.log(
      `⚖️  Employment type "${type.label}" is paid ${type.payBasis} — ` +
        `converging ${drifted.length} employee(s):`,
    );

    for (const emp of drifted) {
      const rate = Number(emp.baseSalary);
      const review =
        type.payBasis === 'DAILY' && rate > SUSPICIOUS_DAY_RATE
          ? '  ** REVIEW: this looks like a monthly figure, not a day rate **'
          : '';
      console.log(
        `   ${(emp.employeeCode ?? '—').padEnd(12)} ${(emp.fullName ?? '').padEnd(28)} ` +
          `${emp.salaryType} -> ${type.payBasis}  rate ${rate}${review}`,
      );

      await prisma.$transaction([
        prisma.employee.update({
          where: { id: emp.id },
          data: { salaryType: type.payBasis! },
        }),
        prisma.employeeHistory.create({
          data: {
            employeeId: emp.id,
            field: 'salaryType',
            oldValue: emp.salaryType,
            newValue: type.payBasis!,
            changedBy: admin.id,
          },
        }),
      ]);
    }
  }
}

async function main() {
  console.log('🌱 Starting database seeding...');

  // 0. Library items (positions, leave types, document types, and the
  //    employment types that carry the pay basis — "Daily Wage" among them).
  //    Every HR module reads these, so a database seeded without them is not
  //    actually usable. The same function runs on app boot, so this is purely
  //    about making `prisma:seed` self-sufficient.
  console.log('📚 Seeding library defaults...');
  await seedLibraryDefaults(prisma);

  // 0b. Converge each employee's pay basis onto their employment type.
  await convergePayBasis();

  // 0c. Employee Profile Template. Same function runs on app boot; repeated
  //     here so `prisma:seed` alone leaves a usable employee form, and because
  //     environments deployed with `db push` never execute the migration that
  //     would otherwise have created it. Create-only: it can never overwrite an
  //     admin's customization, however many times it runs.
  console.log('🧩 Seeding employee profile template...');
  const payrollCountry = await prisma.systemSetting.findUnique({
    where: { key: 'payroll_country' },
    select: { value: true },
  });
  const tplResult = await ensureCompanyTemplate(
    prisma as any,
    payrollCountry?.value ?? null,
  );
  console.log(
    `   ${tplResult.fieldsSeeded} fields, ${tplResult.sectionsSeeded} sections`,
  );

  // 1. Create or get default department
  let department = await prisma.department.findFirst({
    where: { code: 'HRD' },
  });

  if (!department) {
    console.log('🏢 Creating default department (Human Resources)...');
    department = await prisma.department.create({
      data: {
        code: 'HRD',
        name: 'Human Resources',
        description: 'Default department for HR and Administration',
        isActive: true,
      },
    });
  }

  // 1b. Create or get default branch (Head Office), copying current global
  //     system settings into its per-branch config on first creation.
  let branch = await prisma.branch.findFirst({ where: { code: 'HO' } });
  if (!branch) {
    console.log('🏬 Creating default branch (Head Office)...');
    const settingRows = await prisma.systemSetting.findMany({
      where: {
        key: {
          in: [
            'system_timezone',
            'office_start_time',
            'office_end_time',
            'geofencing_enabled',
            'office_latitude',
            'office_longitude',
            'geofencing_radius_meters',
          ],
        },
      },
    });
    const settings = Object.fromEntries(settingRows.map((s) => [s.key, s.value]));
    const num = (v?: string) =>
      v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : null;
    branch = await prisma.branch.create({
      data: {
        code: 'HO',
        name: 'Head Office',
        description: 'Default branch (migrated from global system settings)',
        isActive: true,
        timezone: settings['system_timezone'] ?? null,
        officeStartTime: settings['office_start_time'] ?? null,
        officeEndTime: settings['office_end_time'] ?? null,
        geofencingEnabled:
          settings['geofencing_enabled'] !== undefined
            ? settings['geofencing_enabled'] === 'true'
            : null,
        latitude: num(settings['office_latitude']),
        longitude: num(settings['office_longitude']),
        geofenceRadiusM: num(settings['geofencing_radius_meters']) ?? null,
      },
    });
  }

  // 1c. Backfill existing data onto the default branch (idempotent) and
  //     grandfather existing ADMINs to all-branch (global) access so nobody
  //     is locked out. Replaces the expand/backfill migration DML under the
  //     db-push workflow.
  const backfilledEmployees = await prisma.employee.updateMany({
    where: { branchId: null },
    data: { branchId: branch.id },
  });
  if (backfilledEmployees.count > 0) {
    console.log(`🔁 Backfilled ${backfilledEmployees.count} employees -> Head Office.`);
  }
  await prisma.$executeRaw`
    UPDATE "attendances" a SET "branch_id" = e."branch_id"
    FROM "employees" e
    WHERE a."employee_id" = e."id" AND a."branch_id" IS NULL`;
  await prisma.user.updateMany({
    where: { role: 'ADMIN', isGlobalBranchAccess: false },
    data: { isGlobalBranchAccess: true },
  });
  const privileged = await prisma.user.findMany({
    where: { role: { in: ['ADMIN', 'HR_MANAGER'] } },
    select: { id: true },
  });
  for (const u of privileged) {
    await prisma.userBranchAccess.upsert({
      where: { userId_branchId: { userId: u.id, branchId: branch.id } },
      update: {},
      create: { userId: u.id, branchId: branch.id },
    });
  }

  // Passwords to hash
  const adminPassword = await bcrypt.hash('Admin@123', 10);
  const commonPassword = await bcrypt.hash('Password123!', 10);

  const seedUsers = [
    {
      email: 'admin@company.com',
      passwordHash: adminPassword,
      role: 'ADMIN',
      fullName: 'System Admin',
      employeeCode: 'ADM001',
      idCard: 'ID-ADMIN-001',
      position: 'System Administrator',
    },
    {
      email: 'hr.manager@company.com',
      passwordHash: commonPassword,
      role: 'HR_MANAGER',
      fullName: 'HR Manager',
      employeeCode: 'HRM001',
      idCard: 'ID-HR-001',
      position: 'HR Manager',
    },
    {
      email: 'employee1@company.com',
      passwordHash: commonPassword,
      role: 'EMPLOYEE',
      fullName: 'John Employee',
      employeeCode: 'EMP001',
      idCard: 'ID-EMP-001',
      position: 'Software Developer',
    },
  ];

  for (const userData of seedUsers) {
    console.log(`👤 Processing user: ${userData.email}`);

    // 2. Create or get employee
    let employee = await prisma.employee.findUnique({
      where: { email: userData.email },
    });

    if (!employee) {
      console.log(`  Creating employee record for ${userData.fullName}...`);
      employee = await prisma.employee.create({
        data: {
          employeeCode: userData.employeeCode,
          fullName: userData.fullName,
          email: userData.email,
          idCard: userData.idCard,
          position: userData.position,
          departmentId: department.id,
          branchId: branch.id,
          startDate: new Date(),
          baseSalary: 0,
          status: 'ACTIVE',
          dateOfBirth: new Date('1990-01-01'),
        },
      });
    } else {
      console.log(`  Updating base salary to 0 for employee ${userData.fullName}...`);
      employee = await prisma.employee.update({
        where: { id: employee.id },
        data: {
          baseSalary: 0,
        },
      });
    }

    // 3. Create or update user
    const isGlobalBranchAccess = userData.role === 'ADMIN';
    const user = await prisma.user.upsert({
      where: { email: userData.email },
      update: {
        passwordHash: userData.passwordHash,
        role: userData.role,
        isActive: true,
        isGlobalBranchAccess,
      },
      create: {
        email: userData.email,
        passwordHash: userData.passwordHash,
        role: userData.role,
        employeeId: employee.id,
        isActive: true,
        isEmailVerified: true,
        isGlobalBranchAccess,
      },
    });

    // 3b. Grant branch access to privileged roles (admins are also global)
    if (userData.role === 'ADMIN' || userData.role === 'HR_MANAGER') {
      await prisma.userBranchAccess.upsert({
        where: { userId_branchId: { userId: user.id, branchId: branch.id } },
        update: {},
        create: { userId: user.id, branchId: branch.id },
      });
    }

    console.log(`✅ User ${userData.email} processed successfully.`);
  }

  // Default project-management workflow (kanban columns) -------------------
  let workflow = await prisma.workflow.findFirst({ where: { isDefault: true } });
  if (!workflow) {
    console.log('🗂️  Creating default project workflow...');
    workflow = await prisma.workflow.create({
      data: {
        name: 'Default Workflow',
        description: 'Default kanban workflow for new projects',
        isDefault: true,
        statuses: {
          create: [
            { name: 'To Do', color: '#64748B', category: 'TODO', position: 0, isDefault: true },
            { name: 'In Progress', color: '#00358F', category: 'IN_PROGRESS', position: 1 },
            { name: 'In Review', color: '#f66600', category: 'IN_PROGRESS', position: 2 },
            { name: 'Done', color: '#16A34A', category: 'DONE', position: 3 },
          ],
        },
      },
    });
    console.log('✅ Default workflow created with 4 statuses.');
  }

  // One-time data repairs -------------------------------------------------
  // Deliberately non-fatal: a repair that fails must not crash-loop the
  // container. It leaves its marker unwritten and retries on the next deploy.
  try {
    await backfillScheduleTimezone(prisma);
  } catch (e) {
    console.error(
      '⚠️  Work-schedule timezone backfill failed (will retry next deploy):',
      e instanceof Error ? e.message : e,
    );
  }

  console.log('✅ Seeding completed successfully!');
}

main()
  .catch((e) => {
    console.error('❌ Seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

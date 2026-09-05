/**
 * Demo dataset for the HR suite: assets + clearance, travel, training,
 * grievances, letters, the document vault and the expiry-reminder engine.
 *
 * Idempotent — every write is keyed on a stable `DEMO-` identifier, so running
 * it twice changes nothing. Deliberately builds records at the *interesting*
 * states rather than empty ones: an asset already held (so clearance blocks), a
 * certificate expiring in 20 days (so a reminder tier fires), a grievance
 * against a manager (so the confidentiality rule is exercisable by hand).
 *
 * Run from apps/backend, pointing at a DEV/LOCAL database — never PROD:
 *   DATABASE_URL="postgresql://…@localhost:8068/myappdb?schema=public" \
 *     npm run prisma:seed:hr-suite
 *
 * Undo:
 *   SEED_CLEANUP=1 npm run prisma:seed:hr-suite
 */

import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { seedLibraryDefaults } from '../src/library-items/library-defaults';

const prisma = new PrismaClient();

/** Everything this script creates carries this marker, so cleanup is exact. */
const TAG = 'DEMO';
const PASSWORD = 'Passw0rd!';

const day = (offsetDays: number) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d;
};

async function cleanup() {
  console.log('🧹 Removing demo data…');
  const branch = await prisma.branch.findUnique({ where: { code: `${TAG}-BR` } });
  if (!branch) {
    console.log('   nothing to remove.');
    return;
  }
  const branchId = branch.id;

  // FK-safe order: children before parents.
  await prisma.grievanceEvent.deleteMany({ where: { grievance: { employee: { branchId } } } });
  await prisma.grievance.deleteMany({ where: { employee: { branchId } } });
  await prisma.letterRequest.deleteMany({ where: { employee: { branchId } } });
  await prisma.employeeDocument.deleteMany({ where: { employee: { branchId } } });
  await prisma.reminderDispatch.deleteMany({ where: { sourceKey: { in: ['asset_warranty', 'training_certificate', 'legal_document'] } } });
  await prisma.budgetCommitment.deleteMany({ where: { line: { budget: { branchId } } } });
  await prisma.budgetLine.deleteMany({ where: { budget: { branchId } } });
  await prisma.budget.deleteMany({ where: { branchId } });
  await prisma.trainingNomination.deleteMany({ where: { employee: { branchId } } });
  await prisma.trainingSession.deleteMany({ where: { branchId } });
  await prisma.course.deleteMany({ where: { code: { startsWith: `${TAG}-` } } });
  await prisma.reimbursement.deleteMany({ where: { employee: { branchId } } });
  await prisma.travelItinerary.deleteMany({ where: { travel: { employee: { branchId } } } });
  await prisma.travelRequest.deleteMany({ where: { employee: { branchId } } });
  await prisma.advanceLoanRequest.deleteMany({ where: { employee: { branchId } } });
  await prisma.assetAssignment.deleteMany({ where: { asset: { branchId } } });
  await prisma.assetItem.deleteMany({ where: { branchId } });
  await prisma.employeeLegalDocument.deleteMany({ where: { employee: { branchId } } });
  await prisma.requestApproval.deleteMany({ where: { requestType: { in: ['TRAVEL', 'TRAINING'] } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: `@${TAG.toLowerCase()}.hrms.local` } } });
  await prisma.employee.deleteMany({ where: { branchId } });
  await prisma.department.deleteMany({ where: { code: `${TAG}-DEP` } });
  await prisma.branch.deleteMany({ where: { id: branchId } });
  console.log('✅ Demo data removed.');
}

async function main() {
  if (process.env.SEED_CLEANUP === '1') {
    await cleanup();
    return;
  }

  console.log('🌱 Seeding HR suite demo data…');

  // Masters first — every dropdown in the suite reads from these, and an empty
  // master is the difference between a working form and a dead one.
  await seedLibraryDefaults(prisma as any);
  console.log('   ✓ library masters');

  const hash = await bcrypt.hash(PASSWORD, 10);

  const branch = await prisma.branch.upsert({
    where: { code: `${TAG}-BR` },
    update: {},
    create: {
      code: `${TAG}-BR`,
      name: 'Demo Branch — Muscat',
      isActive: true,
      timezone: 'Asia/Muscat',
      country: 'OM',
    },
  });

  const dept = await prisma.department.upsert({
    where: { code: `${TAG}-DEP` },
    update: {},
    create: { code: `${TAG}-DEP`, name: 'Demo Operations', isActive: true },
  });

  async function ensureEmployee(
    code: string,
    fullName: string,
    role: string,
    opts: { salary?: number } = {},
  ) {
    const email = `${code.toLowerCase()}@${TAG.toLowerCase()}.hrms.local`;
    const employee = await prisma.employee.upsert({
      where: { email },
      update: {},
      create: {
        employeeCode: code,
        fullName,
        email,
        idCard: `ID-${code}`,
        dateOfBirth: new Date('1992-04-11'),
        startDate: new Date('2021-01-04'),
        departmentId: dept.id,
        position: 'Operations Engineer',
        branchId: branch.id,
        baseSalary: opts.salary ?? 1200,
        status: 'ACTIVE',
      },
    });
    await prisma.user.upsert({
      where: { email },
      update: {},
      create: {
        email,
        passwordHash: hash,
        role,
        employeeId: employee.id,
        isActive: true,
        isGlobalBranchAccess: role === 'ADMIN',
        ...(role === 'ADMIN' ? {} : { branchAccess: { create: [{ branchId: branch.id }] } }),
      },
    });
    return employee;
  }

  const admin = await ensureEmployee(`${TAG}-ADM`, 'Demo HR Admin', 'ADMIN', { salary: 2500 });
  const manager = await ensureEmployee(`${TAG}-MGR`, 'Demo Line Manager', 'MANAGER', { salary: 1800 });
  const alice = await ensureEmployee(`${TAG}-E01`, 'Demo Alice Rahman', 'EMPLOYEE');
  const bilal = await ensureEmployee(`${TAG}-E02`, 'Demo Bilal Nasser', 'EMPLOYEE');

  await prisma.department.update({
    where: { id: dept.id },
    data: { managerId: manager.id },
  });
  const adminUser = await prisma.user.findUniqueOrThrow({
    where: { email: `${TAG}-adm@${TAG.toLowerCase()}.hrms.local`.toLowerCase() },
  });
  console.log('   ✓ branch, department, 4 employees');

  // ── Assets ────────────────────────────────────────────────────────────────
  // One asset stays HELD so offboarding clearance visibly blocks; one is due for
  // a warranty reminder inside the 30-day tier.
  const laptop = await prisma.assetItem.upsert({
    // R2 — asset_tag is unique per BRANCH, so the pair identifies the row.
    where: {
      branchId_assetTag: { branchId: branch.id, assetTag: `${TAG}-LT-001` },
    },
    update: {},
    create: {
      assetTag: `${TAG}-LT-001`,
      category: 'Laptop',
      name: 'Dell Latitude 5540',
      serialNumber: 'SN-DEMO-5540',
      branchId: branch.id,
      status: 'AVAILABLE',
      purchaseDate: day(-400),
      purchaseCost: 850,
      warrantyExpiry: day(25), // inside the 30-day reminder tier
    },
  });
  await prisma.assetItem.upsert({
    // R2 — asset_tag is unique per BRANCH, so the pair identifies the row.
    where: {
      branchId_assetTag: { branchId: branch.id, assetTag: `${TAG}-PH-001` },
    },
    update: {},
    create: {
      assetTag: `${TAG}-PH-001`,
      category: 'Mobile Phone',
      name: 'iPhone 15',
      branchId: branch.id,
      status: 'AVAILABLE',
      warrantyExpiry: day(400), // far out — must NOT trigger a reminder
    },
  });
  await prisma.assetItem.upsert({
    // R2 — asset_tag is unique per BRANCH, so the pair identifies the row.
    where: {
      branchId_assetTag: { branchId: branch.id, assetTag: `${TAG}-SIM-001` },
    },
    update: {},
    create: {
      assetTag: `${TAG}-SIM-001`,
      category: 'SIM Card',
      name: 'Corporate SIM',
      branchId: branch.id,
      status: 'AVAILABLE',
    },
  });

  const heldAlready = await prisma.assetAssignment.findFirst({
    where: { assetId: laptop.id, returnedAt: null },
  });
  if (!heldAlready) {
    await prisma.$transaction([
      prisma.assetAssignment.create({
        data: {
          assetId: laptop.id,
          employeeId: alice.id,
          assignedAt: day(-30),
          assignedById: adminUser.id,
          conditionOut: 'New',
        },
      }),
      prisma.assetItem.update({
        where: { id: laptop.id },
        data: { status: 'ASSIGNED' },
      }),
    ]);
  }
  console.log('   ✓ 3 assets (1 held by Alice — clearance will block her exit)');

  // ── Travel ────────────────────────────────────────────────────────────────
  const destination = await prisma.libraryItem.findFirst({
    where: { libraryType: 'PER_DIEM_DESTINATION', label: 'GCC' },
  });
  const existingTrip = await prisma.travelRequest.findFirst({
    where: { employeeId: bilal.id, purpose: { startsWith: `${TAG}:` } },
  });
  if (!existingTrip) {
    await prisma.travelRequest.create({
      data: {
        employeeId: bilal.id,
        purpose: `${TAG}: Vendor visit and contract signing`,
        travelType: 'INTERNATIONAL',
        destination: destination?.label ?? 'GCC',
        country: 'United Arab Emirates',
        departureDate: day(14),
        returnDate: day(18),
        perDiemRate: destination?.perDiemRate ?? 60,
        perDiemDays: 5,
        estimatedCost: 900,
        advanceAmount: 300,
        status: 'PENDING',
        itinerary: {
          create: [
            {
              legOrder: 1,
              mode: 'FLIGHT',
              fromPlace: 'Muscat',
              toPlace: 'Dubai',
              startAt: day(14),
              reference: 'DEMO-PNR-1',
            },
            {
              legOrder: 2,
              mode: 'HOTEL',
              toPlace: 'Dubai',
              startAt: day(14),
              endAt: day(18),
            },
          ],
        },
      },
    });
  }
  console.log('   ✓ 1 pending international trip (visa gap + advance on approval)');

  // ── Training ──────────────────────────────────────────────────────────────
  const course = await prisma.course.upsert({
    where: { code: `${TAG}-SEC-101` },
    update: {},
    create: {
      code: `${TAG}-SEC-101`,
      title: 'Information Security Awareness',
      category: 'Compliance',
      provider: 'Internal L&D',
      description:
        'Phishing recognition, password hygiene, secure handling of employee data.',
      durationHours: 8,
      defaultCost: 150,
      certValidMonths: 12,
      isActive: true,
    },
  });
  await prisma.course.upsert({
    where: { code: `${TAG}-LEAD-201` },
    update: {},
    create: {
      code: `${TAG}-LEAD-201`,
      title: 'First-Line Leadership',
      category: 'Leadership',
      provider: 'External',
      durationHours: 16,
      defaultCost: 400,
      isActive: true,
    },
  });

  let session = await prisma.trainingSession.findFirst({
    where: { courseId: course.id, branchId: branch.id },
  });
  if (!session) {
    session = await prisma.trainingSession.create({
      data: {
        courseId: course.id,
        branchId: branch.id,
        startDate: day(21),
        endDate: day(22),
        location: 'Muscat HQ — Training Room 2',
        trainer: 'Demo Trainer',
        seats: 10,
        costPerSeat: 150,
      },
    });
  }

  // A past, attended session gives the vault a certificate AND puts one inside
  // the reminder window — both flows are then demonstrable without waiting.
  let pastSession = await prisma.trainingSession.findFirst({
    where: { courseId: course.id, status: 'COMPLETED' },
  });
  if (!pastSession) {
    pastSession = await prisma.trainingSession.create({
      data: {
        courseId: course.id,
        branchId: branch.id,
        startDate: day(-345),
        endDate: day(-344),
        location: 'Muscat HQ',
        status: 'COMPLETED',
        costPerSeat: 150,
      },
    });
  }
  const attended = await prisma.trainingNomination.findFirst({
    where: { sessionId: pastSession.id, employeeId: alice.id },
  });
  if (!attended) {
    await prisma.trainingNomination.create({
      data: {
        sessionId: pastSession.id,
        employeeId: alice.id,
        nominatedById: adminUser.id,
        source: 'MANUAL',
        cost: 150,
        status: 'ATTENDED',
        approverId: adminUser.id,
        approvedAt: day(-350),
        attendedAt: day(-344),
        score: 92,
        passed: true,
        // 12-month validity from a session that ended ~344 days ago, so the
        // certificate lands ~20 days out — inside the 30-day reminder tier.
        certificateExpiry: day(20),
      },
    });
  }
  console.log('   ✓ 2 courses, 2 sessions, 1 attended (certificate expires in 20d)');

  // ── Visa, for the legal-document reminder + travel visa-gap check ──────────
  const visa = await prisma.employeeLegalDocument.findFirst({
    where: { employeeId: alice.id, documentNumber: `${TAG}-VISA-001` },
  });
  if (!visa) {
    await prisma.employeeLegalDocument.create({
      data: {
        employeeId: alice.id,
        category: 'VISA',
        documentNumber: `${TAG}-VISA-001`,
        documentType: 'Employment Visa',
        country: 'Oman',
        issueDate: day(-700),
        expiryDate: day(55), // inside the 60-day tier
        issuingAuthority: 'ROP',
        status: 'ACTIVE',
        isCurrent: true,
      },
    });
  }
  console.log('   ✓ 1 visa expiring in 55d (60-day reminder tier)');

  // ── Grievance ─────────────────────────────────────────────────────────────
  // Raised BY Alice AGAINST her own department manager — the case that proves
  // department scoping must not be the access rule.
  const grievance = await prisma.grievance.findFirst({
    where: { employeeId: alice.id, subject: { startsWith: `${TAG}:` } },
  });
  if (!grievance) {
    await prisma.grievance.create({
      data: {
        employeeId: alice.id,
        category: 'Management Practice',
        subject: `${TAG}: Unfair allocation of weekend shifts`,
        description:
          'Weekend shifts have been allocated to me three weeks running while the rota shows others were available.',
        isConfidential: true,
        againstEmployeeId: manager.id,
        status: 'OPEN',
        events: {
          create: {
            type: 'STATUS_CHANGE',
            toStatus: 'OPEN',
            note: 'Grievance raised',
            actorUserId: adminUser.id,
          },
        },
      },
    });
  }
  console.log('   ✓ 1 confidential grievance against the line manager');

  // ── Budget ────────────────────────────────────────────────────────────────
  const budget = await prisma.budget.upsert({
    where: {
      branchId_fiscalYear_name: {
        branchId: branch.id,
        fiscalYear: new Date().getFullYear(),
        name: `${TAG} Operating Budget`,
      },
    },
    update: {},
    create: {
      name: `${TAG} Operating Budget`,
      fiscalYear: new Date().getFullYear(),
      startDate: new Date(new Date().getFullYear(), 0, 1),
      endDate: new Date(new Date().getFullYear(), 11, 31),
      branchId: branch.id,
      currency: 'OMR',
      status: 'ACTIVE',
      createdById: adminUser.id,
    },
  });
  for (const [category, planned] of [
    ['Travel', 8000],
    ['Training', 6000],
    ['Payroll', 120000],
    ['Overtime', 9000],
  ] as const) {
    const existingLine = await prisma.budgetLine.findFirst({
      where: { budgetId: budget.id, departmentId: dept.id, category },
    });
    if (!existingLine) {
      await prisma.budgetLine.create({
        data: {
          budgetId: budget.id,
          departmentId: dept.id,
          category,
          plannedAmount: planned,
        },
      });
    }
  }
  console.log('   ✓ active budget with 4 department lines');

  console.log('\n✅ Demo seed complete.');
  console.log(`   Sign in with any of these (password: ${PASSWORD})`);
  console.log(`     ADMIN     ${TAG.toLowerCase()}-adm@${TAG.toLowerCase()}.hrms.local`);
  console.log(`     MANAGER   ${TAG.toLowerCase()}-mgr@${TAG.toLowerCase()}.hrms.local`);
  console.log(`     EMPLOYEE  ${TAG.toLowerCase()}-e01@${TAG.toLowerCase()}.hrms.local  (Alice — holds a laptop)`);
  console.log(`     EMPLOYEE  ${TAG.toLowerCase()}-e02@${TAG.toLowerCase()}.hrms.local  (Bilal — pending trip)`);
  console.log('\n   Try: approve Bilal\'s trip → a per-diem claim and an advance appear.');
  console.log('        Terminate Alice → blocked until the laptop is returned.');
  console.log('        Sign in as the manager → the grievance about them is invisible.');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

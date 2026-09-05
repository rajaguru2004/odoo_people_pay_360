import * as bcrypt from 'bcrypt';
import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { RemindersService } from '../src/reminders/reminders.service';

/**
 * The expiry-reminder engine, driven against the real database.
 *
 * The unit spec proves the tier arithmetic in isolation. This proves the parts
 * only a real run can: that the four registered sources actually find their
 * rows, that dedupe survives a second run, that a renewal re-arms, and — the one
 * that would be embarrassing in production — that a lapsed record does NOT get
 * chased forever.
 */
describe('Expiry reminders (e2e)', () => {
  let ctx: E2EContext;
  let reminders: RemindersService;
  const PASSWORD = 'Passw0rd!';
  const runId = `rem${Date.now()}`;

  let branchId: string;
  let deptId: string;
  let empId: string;
  let hrUserId: string;
  let empUserId: string;
  let courseId: string;

  const day = (n: number) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + n);
    return d;
  };

  /** Reminder rows written for a source, newest first. */
  const dispatches = (sourceKey: string) =>
    ctx.prisma.reminderDispatch.findMany({
      where: { sourceKey },
      orderBy: { sentAt: 'desc' },
    });

  beforeAll(async () => {
    ctx = await bootE2EApp();
    reminders = ctx.app.get(RemindersService);
    const { prisma } = ctx;
    const hash = await bcrypt.hash(PASSWORD, 10);

    branchId = (
      await prisma.branch.create({
        data: { code: `REM-BR-${runId}`, name: 'Reminders E2E', isActive: true },
      })
    ).id;
    deptId = (
      await prisma.department.create({
        data: { code: `REM-DEP-${runId}`, name: `Dept ${runId}`, isActive: true },
      })
    ).id;

    hrUserId = (
      await prisma.user.create({
        data: {
          email: `hr-${runId}@test.local`,
          passwordHash: hash,
          role: 'HR_MANAGER',
          isActive: true,
          isGlobalBranchAccess: true,
        },
      })
    ).id;

    const employee = await prisma.employee.create({
      data: {
        employeeCode: `REM-${runId}`,
        fullName: `Reminder Subject ${runId}`,
        email: `emp-${runId}@test.local`,
        idCard: `ID-${runId}`,
        dateOfBirth: new Date('1990-01-01'),
        startDate: new Date('2020-01-01'),
        departmentId: deptId,
        position: 'Engineer',
        branchId,
        baseSalary: 1000,
        status: 'ACTIVE',
      },
    });
    empId = employee.id;
    empUserId = (
      await prisma.user.create({
        data: {
          email: `emp-${runId}@test.local`,
          passwordHash: hash,
          role: 'EMPLOYEE',
          employeeId: employee.id,
          isActive: true,
          branchAccess: { create: [{ branchId }] },
        },
      })
    ).id;

    courseId = (
      await prisma.course.create({
        data: {
          code: `REM-C-${runId}`,
          title: 'Reminder Course',
          certValidMonths: 12,
          isActive: true,
        },
      })
    ).id;
  });

  afterAll(async () => {
    const { prisma } = ctx;
    await prisma.reminderDispatch.deleteMany({
      where: { entityId: { in: await entityIds() } },
    });
    await prisma.notification.deleteMany({
      where: { userId: { in: [hrUserId, empUserId] } },
    });
    await prisma.trainingNomination.deleteMany({ where: { employee: { branchId } } });
    await prisma.trainingSession.deleteMany({ where: { branchId } });
    await prisma.course.deleteMany({ where: { id: courseId } });
    await prisma.employeeLegalDocument.deleteMany({ where: { employeeId: empId } });
    await prisma.assetAssignment.deleteMany({ where: { asset: { branchId } } });
    await prisma.assetItem.deleteMany({ where: { branchId } });
    await prisma.contract.deleteMany({ where: { employeeId: empId } });
    await prisma.user.deleteMany({
      where: { email: { endsWith: `${runId}@test.local` } },
    });
    await prisma.employee.deleteMany({ where: { branchId } });
    await prisma.department.deleteMany({ where: { id: deptId } });
    await prisma.branch.deleteMany({ where: { id: branchId } });
    await ctx.app.close();
  });

  /** Ids this suite created, so cleanup never touches another run's rows. */
  async function entityIds(): Promise<string[]> {
    const [assets, visas, certs, contracts] = await Promise.all([
      ctx.prisma.assetItem.findMany({ where: { branchId }, select: { id: true } }),
      ctx.prisma.employeeLegalDocument.findMany({
        where: { employeeId: empId },
        select: { id: true },
      }),
      ctx.prisma.trainingNomination.findMany({
        where: { employeeId: empId },
        select: { id: true },
      }),
      ctx.prisma.contract.findMany({
        where: { employeeId: empId },
        select: { id: true },
      }),
    ]);
    return [...assets, ...visas, ...certs, ...contracts].map((r) => r.id);
  }

  it('registers all four expiring sources', () => {
    const keys = reminders.listSources().map((s) => s.key).sort();
    expect(keys).toEqual(
      ['asset_warranty', 'contract', 'legal_document', 'training_certificate'].sort(),
    );
  });

  describe('asset warranty', () => {
    let assetId: string;

    it('fires the tightest crossed tier and notifies HR', async () => {
      assetId = (
        await ctx.prisma.assetItem.create({
          data: {
            assetTag: `REM-A-${runId}`,
            category: 'Laptop',
            name: 'Warranty Test',
            branchId,
            status: 'AVAILABLE',
            warrantyExpiry: day(25), // crosses 60 and 30; 30 is the tight one
          },
        })
      ).id;

      await reminders.runAll();

      const rows = (await dispatches('asset_warranty')).filter(
        (d) => d.entityId === assetId,
      );
      const thresholds = rows.map((r) => r.threshold).sort((a, b) => b - a);
      // 60 is burned as moot, 30 is the one that actually sent.
      expect(thresholds).toEqual([60, 30]);

      const notified = await ctx.prisma.notification.count({
        where: { userId: hrUserId, title: { contains: 'Asset warranty' } },
      });
      expect(notified).toBeGreaterThan(0);
    });

    it('is silent on a second run — the whole point of the dispatch table', async () => {
      const before = await ctx.prisma.notification.count({ where: { userId: hrUserId } });
      await reminders.runAll();
      const after = await ctx.prisma.notification.count({ where: { userId: hrUserId } });
      expect(after).toBe(before);
    });

    it('ignores a RETIRED asset — nobody cares about its warranty', async () => {
      const retired = await ctx.prisma.assetItem.create({
        data: {
          assetTag: `REM-RET-${runId}`,
          category: 'Laptop',
          name: 'Retired',
          branchId,
          status: 'RETIRED',
          warrantyExpiry: day(10),
        },
      });
      await reminders.runAll();
      const rows = (await dispatches('asset_warranty')).filter(
        (d) => d.entityId === retired.id,
      );
      expect(rows).toHaveLength(0);
    });

    it('never chases an already-lapsed warranty', async () => {
      const lapsed = await ctx.prisma.assetItem.create({
        data: {
          assetTag: `REM-EXP-${runId}`,
          category: 'Laptop',
          name: 'Already lapsed',
          branchId,
          status: 'AVAILABLE',
          warrantyExpiry: day(-5),
        },
      });
      await reminders.runAll();
      const rows = (await dispatches('asset_warranty')).filter(
        (d) => d.entityId === lapsed.id,
      );
      // A past date is outside the [today, horizon] window, and daysRemaining < 0
      // is refused even if it somehow got there.
      expect(rows).toHaveLength(0);
    });

    it('escalates to the next tier as the date approaches', async () => {
      await ctx.prisma.assetItem.update({
        where: { id: assetId },
        data: { warrantyExpiry: day(5) }, // now crosses the 7-day tier
      });
      await reminders.runAll();

      const rows = (await dispatches('asset_warranty')).filter(
        (d) => d.entityId === assetId,
      );
      // The expiry moved, which re-arms every tier — the same behaviour a
      // renewal relies on. The 7-day tier is the tightest now crossed.
      expect(rows.some((r) => r.threshold === 7)).toBe(true);
    });
  });

  describe('training certificate', () => {
    it('reminds the holder as well as HR', async () => {
      const session = await ctx.prisma.trainingSession.create({
        data: {
          courseId,
          branchId,
          startDate: day(-380),
          endDate: day(-379),
          status: 'COMPLETED',
        },
      });
      const nomination = await ctx.prisma.trainingNomination.create({
        data: {
          sessionId: session.id,
          employeeId: empId,
          nominatedById: hrUserId,
          status: 'ATTENDED',
          attendedAt: day(-379),
          certificateExpiry: day(20),
        },
      });

      await reminders.runAll();

      const rows = (await dispatches('training_certificate')).filter(
        (d) => d.entityId === nomination.id,
      );
      expect(rows.length).toBeGreaterThan(0);

      // A lapsing safety certificate can stop someone working, so the employee
      // is told, not only HR.
      const ownerNotified = await ctx.prisma.notification.count({
        where: { userId: empUserId, title: { contains: 'expiring soon' } },
      });
      expect(ownerNotified).toBeGreaterThan(0);
    });

    it('ignores a nomination that was never attended', async () => {
      const session = await ctx.prisma.trainingSession.create({
        data: { courseId, branchId, startDate: day(30), endDate: day(31) },
      });
      const pending = await ctx.prisma.trainingNomination.create({
        data: {
          sessionId: session.id,
          employeeId: empId,
          nominatedById: hrUserId,
          status: 'APPROVED',
          // Nonsense state on purpose: an expiry with no attendance. Only
          // ATTENDED rows hold a certificate.
          certificateExpiry: day(15),
        },
      });

      await reminders.runAll();

      const rows = (await dispatches('training_certificate')).filter(
        (d) => d.entityId === pending.id,
      );
      expect(rows).toHaveLength(0);
    });
  });

  describe('legal document', () => {
    it('reminds on an ACTIVE, current visa', async () => {
      const visa = await ctx.prisma.employeeLegalDocument.create({
        data: {
          employeeId: empId,
          category: 'VISA',
          documentNumber: `REM-V-${runId}`,
          documentType: 'Employment Visa',
          country: 'Oman',
          issueDate: day(-700),
          expiryDate: day(55),
          status: 'ACTIVE',
          isCurrent: true,
        },
      });

      await reminders.runAll();

      const rows = (await dispatches('legal_document')).filter(
        (d) => d.entityId === visa.id,
      );
      // 90 crossed and burned, 60 sent.
      expect(rows.map((r) => r.threshold).sort((a, b) => b - a)).toEqual([90, 60]);
    });

    it('ignores a superseded record', async () => {
      const old = await ctx.prisma.employeeLegalDocument.create({
        data: {
          employeeId: empId,
          category: 'VISA',
          documentNumber: `REM-OLD-${runId}`,
          documentType: 'Employment Visa',
          country: 'Oman',
          issueDate: day(-1000),
          expiryDate: day(40),
          status: 'RENEWED',
          isCurrent: false,
        },
      });

      await reminders.runAll();

      const rows = (await dispatches('legal_document')).filter(
        (d) => d.entityId === old.id,
      );
      expect(rows).toHaveLength(0);
    });
  });

  describe('resilience', () => {
    it('a run with nothing due is a no-op, not an error', async () => {
      const result = await reminders.runAll();
      expect(result.total).toBe(0);
      expect(Object.keys(result.sent).sort()).toEqual(
        ['asset_warranty', 'contract', 'legal_document', 'training_certificate'].sort(),
      );
    });

    it('records dispatch rows keyed to the expiry date', async () => {
      // Including the expiry in the identity is what lets a renewal re-arm the
      // tiers without deleting history.
      const rows = await ctx.prisma.reminderDispatch.findMany({
        where: { sourceKey: 'asset_warranty' },
        take: 1,
      });
      expect(rows[0]?.expiryDate).toBeTruthy();
    });
  });
});

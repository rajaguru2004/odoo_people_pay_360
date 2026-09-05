import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../src/prisma/prisma.service';
import { LegalDocumentsModule } from '../src/legal-documents/legal-documents.module';
import { LegalDocumentsService } from '../src/legal-documents/legal-documents.service';
import { assertDevDb } from './utils/mcp-harness';
import { TestAppModule } from './utils/test-app.module';

/**
 * End-to-end lifecycle automation: the daily crons.
 *  - auto-expire flips past-expiry ACTIVE records to EXPIRED
 *  - expiry alerts notify HR/admin users + the employee once per record
 *    (dedup via expiryAlertSentAt), honoring the visa_expiry_alert_days setting.
 * Mail sends are exercised through MailService (no-ops with MAIL_ENABLED off);
 * in-app notification rows are asserted directly.
 */
describe('visa lifecycle crons (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let service: LegalDocumentsService;

  const runId = `viscron-${Date.now().toString(36)}`;
  let deptId: string;
  let branchId: string;
  let empId: string;
  let empUserId: string;
  let adminUserId: string;
  let expiringVisaId: string;
  let expiredVisaId: string;

  const day = (offset: number) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + offset);
    return d;
  };

  beforeAll(async () => {
    assertDevDb();
    const moduleRef = await Test.createTestingModule({
      imports: [TestAppModule, LegalDocumentsModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    service = app.get(LegalDocumentsService);

    // Minimal fixtures, runId-tagged for safe cleanup.
    const dept = await prisma.department.create({
      data: { code: `D-${runId}`, name: `Dept ${runId}` },
    });
    deptId = dept.id;
    const branch = await prisma.branch.create({
      data: { code: `B-${runId}`, name: `Branch ${runId}` },
    });
    branchId = branch.id;
    const emp = await prisma.employee.create({
      data: {
        employeeCode: `E-${runId}`,
        fullName: `Visa Cron ${runId}`,
        dateOfBirth: new Date('1990-01-01'),
        idCard: `IC-${runId}`,
        email: `${runId}@test.local`,
        departmentId: deptId,
        branchId,
        position: 'Tester',
        startDate: day(-100),
        baseSalary: 1000,
      },
    });
    empId = emp.id;
    const empUser = await prisma.user.create({
      data: {
        email: `${runId}@test.local`,
        passwordHash: 'x',
        role: 'EMPLOYEE',
        isActive: true,
        employeeId: empId,
      },
    });
    empUserId = empUser.id;
    const adminUser = await prisma.user.create({
      data: {
        email: `${runId}-admin@test.local`,
        passwordHash: 'x',
        role: 'ADMIN',
        isActive: true,
      },
    });
    adminUserId = adminUser.id;
  }, 120000);

  afterAll(async () => {
    // FK-safe order; visas cascade from employee but delete explicitly anyway.
    await prisma.notification.deleteMany({
      where: { userId: { in: [empUserId, adminUserId] } },
    });
    await prisma.employeeLegalDocument.deleteMany({ where: { employeeId: empId } });
    await prisma.user.deleteMany({ where: { id: { in: [empUserId, adminUserId] } } });
    await prisma.employee.deleteMany({ where: { id: empId } });
    await prisma.branch.deleteMany({ where: { id: branchId } });
    await prisma.department.deleteMany({ where: { id: deptId } });
    await app.close();
  }, 120000);

  it('creates fixtures: one visa inside the alert window, one already past expiry', async () => {
    const expiring = await service.create({
      employeeId: empId,
      documentNumber: `V-${runId}-SOON`,
      documentType: 'Employment Visa',
      country: 'Oman',
      issueDate: day(-300).toISOString().slice(0, 10),
      expiryDate: day(10).toISOString().slice(0, 10), // inside default 30d window
    });
    expiringVisaId = (expiring.data as any).id;
    expect((expiring.data as any).isExpiringSoon).toBe(true);

    // Different country so it can coexist as a "current" record; created ACTIVE
    // by force so the auto-expire cron has something to flip.
    const expired = await service.create({
      employeeId: empId,
      documentNumber: `V-${runId}-PAST`,
      documentType: 'Visit Visa',
      country: 'Qatar',
      issueDate: day(-400).toISOString().slice(0, 10),
      expiryDate: day(-5).toISOString().slice(0, 10),
    });
    expiredVisaId = (expired.data as any).id;
    // Back-dated create is auto-marked EXPIRED at creation — reset to ACTIVE to
    // simulate a record that lapsed while sitting in the DB.
    await prisma.employeeLegalDocument.update({
      where: { id: expiredVisaId },
      data: { status: 'ACTIVE' },
    });
  });

  it('autoExpireLegalDocuments flips past-expiry ACTIVE records to EXPIRED', async () => {
    const res: any = await service.autoExpireLegalDocuments();
    expect(res.success).toBe(true);
    const row = await prisma.employeeLegalDocument.findUnique({ where: { id: expiredVisaId } });
    expect(row?.status).toBe('EXPIRED');
    // The in-window visa stays ACTIVE.
    const soon = await prisma.employeeLegalDocument.findUnique({ where: { id: expiringVisaId } });
    expect(soon?.status).toBe('ACTIVE');
  });

  it('sendExpiryAlerts notifies admins + employee and stamps expiryAlertSentAt', async () => {
    await service.sendExpiryAlerts();

    const row = await prisma.employeeLegalDocument.findUnique({ where: { id: expiringVisaId } });
    expect(row?.expiryAlertSentAt).not.toBeNull();

    const adminNotifs = await prisma.notification.findMany({
      where: { userId: adminUserId, type: 'VISA_EXPIRING' },
    });
    expect(adminNotifs.length).toBe(1);
    expect(adminNotifs[0].message).toContain('Oman');
    expect(adminNotifs[0].link).toContain(`/dashboard/employees/${empId}?section=visa`);

    const empNotifs = await prisma.notification.findMany({
      where: { userId: empUserId, type: 'VISA_EXPIRING' },
    });
    expect(empNotifs.length).toBe(1);
  });

  it('is idempotent: a second run sends no duplicate alerts', async () => {
    await service.sendExpiryAlerts();
    const adminNotifs = await prisma.notification.count({
      where: { userId: adminUserId, type: 'VISA_EXPIRING' },
    });
    expect(adminNotifs).toBe(1);
  });

  it('respects the configurable window: 5-day setting excludes a 10-day-out visa', async () => {
    // Reset the dedup stamp, narrow the window below the visa's 10-day horizon.
    await prisma.employeeLegalDocument.update({
      where: { id: expiringVisaId },
      data: { expiryAlertSentAt: null },
    });
    await prisma.systemSetting.upsert({
      where: { key: 'visa_expiry_alert_days' },
      update: { value: '5' },
      create: { key: 'visa_expiry_alert_days', value: '5' },
    });
    try {
      await service.sendExpiryAlerts();
      const row = await prisma.employeeLegalDocument.findUnique({ where: { id: expiringVisaId } });
      expect(row?.expiryAlertSentAt).toBeNull(); // outside 5d window → untouched
    } finally {
      await prisma.systemSetting.upsert({
        where: { key: 'visa_expiry_alert_days' },
        update: { value: '30' },
        create: { key: 'visa_expiry_alert_days', value: '30' },
      });
    }
  });
});

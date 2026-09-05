import * as bcrypt from 'bcrypt';
import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { bearer } from './utils/fixtures';

/**
 * The three "easy wins", proved end to end.
 *
 * The assertions that matter:
 *   - a letter renders to a REAL pdf, gets a unique serial, is stored PRIVATELY
 *     (never a public URL) and files itself in the employee's vault;
 *   - verification confirms a serial without disclosing name or salary;
 *   - a manager cannot read a grievance raised against them — the thing that
 *     would be broken if department scoping were used as the access rule;
 *   - the vault merges the existing sources rather than storing a fifth copy.
 */
describe('Letters, grievance & document vault (e2e)', () => {
  let ctx: E2EContext;
  const PASSWORD = 'Passw0rd!';
  const runId = `lgv${Date.now()}`;

  const emails = {
    admin: `admin-${runId}@test.local`,
    staff: `staff-${runId}@test.local`,
    boss: `boss-${runId}@test.local`,
    other: `other-${runId}@test.local`,
  };

  let branchId: string;
  let deptId: string;
  let adminToken: string;
  let staffToken: string;
  let bossToken: string;
  let otherToken: string;
  let staffEmpId: string;
  let bossEmpId: string;
  let bossUserId: string;

  async function makeEmployee(email: string, code: string, role = 'EMPLOYEE') {
    const hash = await bcrypt.hash(PASSWORD, 10);
    const employee = await ctx.prisma.employee.create({
      data: {
        employeeCode: code,
        fullName: `Person ${code}`,
        email,
        idCard: `ID-${code}`,
        dateOfBirth: new Date('1990-01-01'),
        startDate: new Date('2020-01-01'),
        departmentId: deptId,
        position: 'Engineer',
        branchId,
        baseSalary: 1500,
        status: 'ACTIVE',
      },
    });
    const user = await ctx.prisma.user.create({
      data: {
        email,
        passwordHash: hash,
        role,
        employeeId: employee.id,
        isActive: true,
        branchAccess: { create: [{ branchId }] },
      },
    });
    return { employeeId: employee.id, userId: user.id };
  }

  async function login(email: string) {
    const res = await ctx.http().post('/auth/login').send({ email, password: PASSWORD });
    return res.body.data.accessToken;
  }

  beforeAll(async () => {
    ctx = await bootE2EApp();
    const { prisma } = ctx;
    const hash = await bcrypt.hash(PASSWORD, 10);

    branchId = (
      await prisma.branch.create({
        data: { code: `LGV-BR-${runId}`, name: 'Letters E2E Branch', isActive: true },
      })
    ).id;
    deptId = (
      await prisma.department.create({
        data: { code: `LGV-DEP-${runId}`, name: `Dept ${runId}`, isActive: true },
      })
    ).id;

    await prisma.user.create({
      data: {
        email: emails.admin,
        passwordHash: hash,
        role: 'ADMIN',
        isActive: true,
        isGlobalBranchAccess: true,
      },
    });

    const staff = await makeEmployee(emails.staff, `LGV-S-${runId}`);
    staffEmpId = staff.employeeId;
    // The "boss" is a MANAGER heading the complainant's department — exactly the
    // person department scoping would wrongly grant access to.
    const boss = await makeEmployee(emails.boss, `LGV-B-${runId}`, 'MANAGER');
    bossEmpId = boss.employeeId;
    bossUserId = boss.userId;
    await prisma.department.update({
      where: { id: deptId },
      data: { managerId: bossEmpId },
    });
    await makeEmployee(emails.other, `LGV-O-${runId}`);

    adminToken = await login(emails.admin);
    staffToken = await login(emails.staff);
    bossToken = await login(emails.boss);
    otherToken = await login(emails.other);
    expect(adminToken).toBeTruthy();
  });

  afterAll(async () => {
    const { prisma } = ctx;
    await prisma.grievanceEvent.deleteMany({
      where: { grievance: { employee: { branchId } } },
    });
    await prisma.grievance.deleteMany({ where: { employee: { branchId } } });
    await prisma.letterRequest.deleteMany({ where: { employee: { branchId } } });
    await prisma.employeeDocument.deleteMany({ where: { employee: { branchId } } });
    await prisma.department.update({ where: { id: deptId }, data: { managerId: null } });
    await prisma.user.deleteMany({
      where: { email: { endsWith: `${runId}@test.local` } },
    });
    await prisma.employee.deleteMany({ where: { branchId } });
    await prisma.department.deleteMany({ where: { id: deptId } });
    await prisma.branch.deleteMany({ where: { id: branchId } });
    await ctx.app.close();
  });

  // ── Letters ───────────────────────────────────────────────────────────────

  describe('self-service letters', () => {
    let requestId: string;
    let serialNumber: string;

    it('ships templates for both locales', async () => {
      const res = await ctx
        .http()
        .get('/letters/templates?activeOnly=true')
        .set(bearer(staffToken))
        .expect(200);

      const keys = res.body.data.map((t: any) => `${t.key}:${t.locale}`);
      expect(keys).toContain('SALARY_CERTIFICATE:en');
      // Arabic matters here — this is an Oman deployment.
      expect(keys).toContain('SALARY_CERTIFICATE:ar');
    });

    it('a salary certificate waits for HR rather than issuing instantly', async () => {
      const res = await ctx
        .http()
        .post('/letters')
        .set(bearer(staffToken))
        .send({
          templateKey: 'SALARY_CERTIFICATE',
          locale: 'en',
          purpose: 'a bank loan application',
          addressedTo: 'Bank Muscat',
        })
        .expect(201);

      requestId = res.body.data.id;
      // It states someone's pay to a bank — it needs a signature step.
      expect(res.body.data.status).toBe('PENDING');
    });

    it('issues a real PDF, stored privately and filed in the vault', async () => {
      const res = await ctx
        .http()
        .post(`/letters/${requestId}/issue`)
        .set(bearer(adminToken))
        .expect(201);

      serialNumber = res.body.data.serialNumber;
      expect(res.body.data.status).toBe('ISSUED');
      expect(serialNumber).toMatch(/^SALARY-\d{4}-\d{5}$/);

      const request = await ctx.prisma.letterRequest.findUnique({
        where: { id: requestId },
      });
      // A private ref, never a URL — a salary certificate must not be readable
      // by link alone.
      expect(request!.fileRef).toMatch(/^private:\/\//);
      expect(request!.fileRef).not.toMatch(/^https?:\/\//);
      expect(request!.documentId).toBeTruthy();

      const doc = await ctx.prisma.employeeDocument.findUnique({
        where: { id: request!.documentId! },
      });
      expect(doc!.isSystemGenerated).toBe(true);
      expect(doc!.mimeType).toBe('application/pdf');
      // A real rendered PDF, not an empty placeholder.
      expect(Number(doc!.fileSize)).toBeGreaterThan(1000);
    }, 60_000);

    it('refuses to issue the same letter twice', async () => {
      await ctx
        .http()
        .post(`/letters/${requestId}/issue`)
        .set(bearer(adminToken))
        .expect(400);
    });

    it('issues an instant letter with no HR step', async () => {
      const res = await ctx
        .http()
        .post('/letters')
        .set(bearer(staffToken))
        .send({ templateKey: 'EXPERIENCE', locale: 'en' })
        .expect(201);
      // Experience letters carry no live financial data.
      expect(res.body.data.status).toBe('ISSUED');
      expect(res.body.data.serialNumber).toBeTruthy();
    }, 60_000);

    it('gives every letter a unique serial', async () => {
      const serials = await ctx.prisma.letterRequest.findMany({
        where: { employeeId: staffEmpId, serialNumber: { not: null } },
        select: { serialNumber: true },
      });
      const unique = new Set(serials.map((s) => s.serialNumber));
      expect(unique.size).toBe(serials.length);
      expect(serials.length).toBeGreaterThanOrEqual(2);
    });

    it('verifies a serial without disclosing its contents', async () => {
      // Unauthenticated on purpose — a bank checking a certificate has no account.
      const res = await ctx.http().get(`/letters/verify/${serialNumber}`).expect(200);

      expect(res.body.data.valid).toBe(true);
      expect(res.body.data.letterType).toBe('SALARY_CERTIFICATE');
      // No name, no salary, no file.
      expect(JSON.stringify(res.body)).not.toMatch(/1500|Person LGV-S/);
    });

    it('reports an unknown serial as invalid rather than 404', async () => {
      const res = await ctx.http().get('/letters/verify/NOPE-2026-00001').expect(200);
      expect(res.body.data.valid).toBe(false);
    });

    it('lets the owner download it, and refuses a colleague', async () => {
      const doc = await ctx.prisma.employeeDocument.findFirst({
        where: { employeeId: staffEmpId, isSystemGenerated: true },
      });

      // Streamed, never redirected: the caller is an XHR carrying a bearer
      // token, and a 302 to object storage would need cross-origin XHR to be
      // allowed on the bucket.
      const mine = await ctx
        .http()
        .get(`/secure-files/employee-document/${doc!.id}`)
        .set(bearer(staffToken))
        .expect(200);

      expect(mine.headers['content-type']).toContain('application/pdf');
      expect(mine.headers['content-disposition']).toContain('attachment');
      // Real bytes, not an empty 200.
      expect(mine.body.length ?? mine.body.byteLength).toBeGreaterThan(1000);
      expect(Buffer.from(mine.body).subarray(0, 5).toString('latin1')).toBe('%PDF-');

      await ctx
        .http()
        .get(`/secure-files/employee-document/${doc!.id}`)
        .set(bearer(otherToken))
        .expect(403);
    });

    it('serves a non-ASCII filename instead of 500ing on the header', async () => {
      // HTTP headers are Latin-1. Generated letters are named from their
      // template — the English one carries an em dash and the Arabic one
      // carries Arabic — so a raw filename threw
      // `Invalid character in header content` and every download 500'd.
      // Point at the object the ISSUE case above actually stored. Hardcoding a
      // serial ('SALARY-2026-00005') assumed `letter_serial_seq` sat at a
      // particular value on a freshly built template, so the row pointed at an
      // object that was never written and the download 404'd before it could
      // reach the header code this case is about.
      const issued = await ctx.prisma.letterRequest.findUniqueOrThrow({
        where: { id: requestId },
      });
      const doc = await ctx.prisma.employeeDocument.create({
        data: {
          employeeId: staffEmpId,
          documentType: 'Letter',
          fileName: 'شهادة راتب — SALARY-2026-99999.pdf',
          fileUrl: issued.fileRef!,
          privateRef: issued.fileRef!,
          mimeType: 'application/pdf',
          isSystemGenerated: true,
        },
      });

      const res = await ctx
        .http()
        .get(`/secure-files/employee-document/${doc.id}`)
        .set(bearer(staffToken))
        .expect(200);

      const disposition = res.headers['content-disposition'];
      // ASCII fallback for old clients…
      expect(disposition).toMatch(/^attachment; filename="/);
      // …plus the RFC 5987 form every current browser prefers.
      expect(disposition).toContain("filename*=UTF-8''");
      expect(decodeURIComponent(disposition.split("filename*=UTF-8''")[1])).toBe(
        'شهادة راتب — SALARY-2026-99999.pdf',
      );

      await ctx.prisma.employeeDocument.delete({ where: { id: doc.id } });
    });

    it('401s without a token — the reason window.open could never work', async () => {
      const doc = await ctx.prisma.employeeDocument.findFirst({
        where: { employeeId: staffEmpId, isSystemGenerated: true },
      });
      // A plain browser tab sends no Authorization header. The frontend must
      // fetch via XHR; this documents why.
      await ctx
        .http()
        .get(`/secure-files/employee-document/${doc!.id}`)
        .expect(401);
    });

    it('404s an unknown download kind', async () => {
      await ctx
        .http()
        .get('/secure-files/nonsense/00000000-0000-0000-0000-000000000000')
        .set(bearer(adminToken))
        .expect(404);
    });
  });

  // ── Grievance ─────────────────────────────────────────────────────────────

  describe('grievance confidentiality', () => {
    let grievanceId: string;

    it('an employee raises a grievance against their own manager', async () => {
      const res = await ctx
        .http()
        .post('/grievances')
        .set(bearer(staffToken))
        .send({
          category: 'Management Practice',
          subject: 'Unfair allocation of work',
          description: 'Details of the complaint.',
          isConfidential: true,
          againstEmployeeId: bossEmpId,
        })
        .expect(201);
      grievanceId = res.body.data.id;
      expect(res.body.data.status).toBe('OPEN');
    });

    it('THE RULE: the manager it is about cannot see it', async () => {
      // This is precisely what department scoping would have got wrong — the
      // head of the complainant's department is the person being complained
      // about.
      const list = await ctx
        .http()
        .get('/grievances')
        .set(bearer(bossToken))
        .expect(200);
      expect(list.body.data.map((g: any) => g.id)).not.toContain(grievanceId);

      // 404, not 403 — confirming it exists is itself a disclosure.
      await ctx
        .http()
        .get(`/grievances/${grievanceId}`)
        .set(bearer(bossToken))
        .expect(404);
    });

    it('was never notified to the subject either', async () => {
      const notified = await ctx.prisma.notification.count({
        where: { userId: bossUserId, title: 'New grievance raised' },
      });
      expect(notified).toBe(0);
    });

    it('an unrelated colleague cannot see it', async () => {
      await ctx
        .http()
        .get(`/grievances/${grievanceId}`)
        .set(bearer(otherToken))
        .expect(404);
    });

    it('the complainant and HR can see it', async () => {
      await ctx
        .http()
        .get(`/grievances/${grievanceId}`)
        .set(bearer(staffToken))
        .expect(200);
      await ctx
        .http()
        .get(`/grievances/${grievanceId}`)
        .set(bearer(adminToken))
        .expect(200);
    });

    it('refuses to assign the case to the person it is about', async () => {
      const res = await ctx
        .http()
        .patch(`/grievances/${grievanceId}`)
        .set(bearer(adminToken))
        .send({ assignedToId: bossUserId })
        .expect(400);
      expect(res.body.message).toMatch(/person it is about/i);
    });

    it('records a status trail', async () => {
      await ctx
        .http()
        .patch(`/grievances/${grievanceId}`)
        .set(bearer(adminToken))
        .send({ status: 'INVESTIGATING', note: 'Assigned to HR for review' })
        .expect(200);

      const res = await ctx
        .http()
        .get(`/grievances/${grievanceId}`)
        .set(bearer(adminToken))
        .expect(200);
      const types = res.body.data.events.map((e: any) => e.type);
      expect(types).toContain('STATUS_CHANGE');
      expect(res.body.data.status).toBe('INVESTIGATING');
    });

    it('hides internal handler notes from the complainant', async () => {
      await ctx
        .http()
        .post(`/grievances/${grievanceId}/notes`)
        .set(bearer(adminToken))
        .send({ note: 'Spoke to two witnesses privately.', isInternal: true })
        .expect(201);

      const hrView = await ctx
        .http()
        .get(`/grievances/${grievanceId}`)
        .set(bearer(adminToken))
        .expect(200);
      const staffView = await ctx
        .http()
        .get(`/grievances/${grievanceId}`)
        .set(bearer(staffToken))
        .expect(200);

      expect(JSON.stringify(hrView.body)).toContain('two witnesses');
      expect(JSON.stringify(staffView.body)).not.toContain('two witnesses');
    });

    it('refuses an internal note from the complainant', async () => {
      await ctx
        .http()
        .post(`/grievances/${grievanceId}/notes`)
        .set(bearer(staffToken))
        .send({ note: 'trying to hide this', isInternal: true })
        .expect(403);
    });

    it('rejects a grievance against yourself', async () => {
      await ctx
        .http()
        .post('/grievances')
        .set(bearer(staffToken))
        .send({
          category: 'Other',
          subject: 'Self',
          description: 'x',
          againstEmployeeId: staffEmpId,
        })
        .expect(400);
    });

    it('lets the complainant withdraw, but not a bystander', async () => {
      const raised = await ctx
        .http()
        .post('/grievances')
        .set(bearer(staffToken))
        .send({ category: 'Other', subject: 'Withdrawable', description: 'x' })
        .expect(201);

      await ctx
        .http()
        .post(`/grievances/${raised.body.data.id}/withdraw`)
        .set(bearer(otherToken))
        .expect(404); // cannot even see it

      await ctx
        .http()
        .post(`/grievances/${raised.body.data.id}/withdraw`)
        .set(bearer(staffToken))
        .expect(201);

      const row = await ctx.prisma.grievance.findUnique({
        where: { id: raised.body.data.id },
      });
      expect(row?.status).toBe('WITHDRAWN');
    });
  });

  // ── Vault ─────────────────────────────────────────────────────────────────

  describe('document vault', () => {
    it('merges letters and contracts into one list', async () => {
      await ctx.prisma.contract.create({
        data: {
          employeeId: staffEmpId,
          contractType: 'INDEFINITE',
          contractNumber: `LGV-CT-${runId}`,
          startDate: new Date('2020-01-01'),
          salary: 1500,
          workType: 'FULL_TIME',
          workHoursPerWeek: 40,
          status: 'ACTIVE',
        },
      });

      const res = await ctx
        .http()
        .get('/document-vault/me')
        .set(bearer(staffToken))
        .expect(200);

      const kinds = new Set(res.body.data.items.map((i: any) => i.kind));
      expect(kinds.has('LETTER')).toBe(true);
      expect(kinds.has('CONTRACT')).toBe(true);
      expect(res.body.data.summary.total).toBeGreaterThanOrEqual(3);

      await ctx.prisma.contract.deleteMany({
        where: { contractNumber: `LGV-CT-${runId}` },
      });
    });

    it('never exposes a public URL for a private letter', async () => {
      const res = await ctx
        .http()
        .get('/document-vault/me')
        .set(bearer(staffToken))
        .expect(200);

      const letters = res.body.data.items.filter((i: any) => i.kind === 'LETTER');
      expect(letters.length).toBeGreaterThan(0);
      for (const l of letters) {
        expect(l.fileUrl).toBeNull();
        // The only way through is the authenticated download route.
        expect(l.secureKind).toBe('employee-document');
        expect(l.secureId).toBeTruthy();
      }
    });

    it('refuses one employee reading another employee vault', async () => {
      await ctx
        .http()
        .get(`/document-vault/employee/${staffEmpId}`)
        .set(bearer(otherToken))
        .expect(403);
    });

    it('a MANAGER cannot read a subordinate vault', async () => {
      // It holds salary certificates and passport scans — not a line manager's
      // business, even for their own team.
      await ctx
        .http()
        .get(`/document-vault/employee/${staffEmpId}`)
        .set(bearer(bossToken))
        .expect(403);
    });

    it('HR can read it', async () => {
      await ctx
        .http()
        .get(`/document-vault/employee/${staffEmpId}`)
        .set(bearer(adminToken))
        .expect(200);
    });
  });
});

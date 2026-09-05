import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { setupPeopleFixtures, PeopleFixtures } from './utils/people-fixtures';
import { bearer } from './utils/settings';

/**
 * Visa / legal documents, end to end.
 *
 * `visa-cron.e2e-spec.ts` covers the AUTOMATION — auto-expire and the alert
 * cron. The records those crons act on had no coverage at all: create, renew,
 * cancel, the renewal chain, the two distinct 409s, attachments, and the
 * read-access rules that decide who may see someone's immigration status.
 *
 * The renewal chain is the part worth being careful about. A renewal is not an
 * edit: the old record becomes RENEWED and stops being current, and a new row
 * points back at it. Get that wrong and either the employee has two current
 * visas (and the expiry cron alerts on the wrong one) or their history is
 * overwritten and there is no record of what they held before.
 */
describe('People — Visa / legal documents (e2e)', () => {
  let ctx: E2EContext;
  let fx: PeopleFixtures;

  const body = (res: any) => JSON.stringify(res.body);
  const rowsOf = (res: any): any[] => {
    const d = res.body?.data;
    return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
  };

  let seq = 0;
  let createdEmployees: string[] = [];

  const daysFromNow = (n: number) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  };

  /** Its own holder per case: the current-visa index is per employee+country. */
  const seedHolder = async (over: Record<string, unknown> = {}) => {
    const n = seq++;
    const e = await ctx.prisma.employee.create({
      data: {
        employeeCode: `VIS-${fx.runId}-${n}`,
        fullName: `Visa Holder ${n}`,
        dateOfBirth: new Date('1990-01-01'),
        idCard: `VISID-${fx.runId}-${n}`,
        email: `vis${n}-${fx.runId}@test.local`,
        departmentId: fx.mainDeptId,
        branchId: fx.branchA,
        position: 'Engineer',
        startDate: new Date('2020-01-01'),
        baseSalary: 40000,
        status: 'ACTIVE',
        ...over,
      } as any,
    });
    createdEmployees.push(e.id);
    return e;
  };

  const newVisa = (employeeId: string, over: Record<string, unknown> = {}) => ({
    employeeId,
    documentNumber: `VN-${fx.runId}-${seq++}`,
    documentType: 'Employment Visa',
    country: 'Oman',
    issueDate: '2024-01-01',
    expiryDate: daysFromNow(200),
    ...over,
  });

  const create = (payload: Record<string, unknown>, token = fx.hr.token) =>
    ctx.http().post('/legal-documents').set(bearer(token)).send(payload);

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupPeopleFixtures(ctx);
  }, 180000);

  afterAll(async () => {
    await ctx.prisma.legalDocumentAttachment.deleteMany({
      where: { legalDocument: { employeeId: { in: createdEmployees } } },
    });
    await ctx.prisma.employeeLegalDocument.deleteMany({
      where: { employeeId: { in: createdEmployees } },
    });
    await ctx.prisma.employee.deleteMany({
      where: { id: { in: createdEmployees } },
    });
    await fx?.cleanup();
    await ctx?.app.close();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Create
  // ───────────────────────────────────────────────────────────────────────────

  it('VISA-API-01: a new visa is ACTIVE and current', async () => {
    const emp = await seedHolder();
    const res = await create(newVisa(emp.id));
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('ACTIVE');
    expect(res.body.data.isCurrent).toBe(true);
  });

  it('VISA-API-02: the issue date must precede the expiry date', async () => {
    const emp = await seedHolder();
    const inverted = await create(
      newVisa(emp.id, { issueDate: '2025-01-01', expiryDate: '2024-01-01' }),
    );
    expect(inverted.status).toBe(400);
    expect(body(inverted)).toContain('Issue date must be before expiry date');

    const equal = await create(
      newVisa(emp.id, { issueDate: '2025-01-01', expiryDate: '2025-01-01' }),
    );
    expect(equal.status).toBe(400);
  });

  it('VISA-API-03: a duplicate document number within the category is a 409', async () => {
    const a = await seedHolder();
    const b = await seedHolder();
    const number = `VNDUP-${fx.runId}-${seq++}`;
    expect((await create(newVisa(a.id, { documentNumber: number }))).status).toBe(201);

    const dup = await create(newVisa(b.id, { documentNumber: number }));
    expect(dup.status).toBe(409);
    expect(body(dup)).toContain('already exists');
  });

  it('VISA-API-04/05: one current visa per employee AND country', async () => {
    const emp = await seedHolder();
    expect((await create(newVisa(emp.id, { country: 'Oman' }))).status).toBe(201);

    const sameCountry = await create(newVisa(emp.id, { country: 'Oman' }));
    expect(sameCountry.status).toBe(409);
    expect(body(sameCountry)).toContain('already has a current');

    // The partial unique index is per country, so a second passport-country
    // visa is a legitimate record, not a conflict.
    const otherCountry = await create(newVisa(emp.id, { country: 'India' }));
    expect(otherCountry.status).toBe(201);
  });

  it('VISA-API-24: a category the schema has but the DTO does not is refused (P8)', async () => {
    const emp = await seedHolder();
    const res = await create(newVisa(emp.id, { category: 'PASSPORT' }));
    expect(res.status).toBe(400);
  });

  it('VISA-API-25: an omitted category defaults to VISA', async () => {
    const emp = await seedHolder();
    const res = await create(newVisa(emp.id));
    expect(res.status).toBe(201);
    expect(res.body.data.category).toBe('VISA');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Read access
  // ───────────────────────────────────────────────────────────────────────────

  it('VISA-API-06: the list answers ADMIN/HR/MANAGER and refuses EMPLOYEE', async () => {
    for (const actor of [fx.admin, fx.hr, fx.manager]) {
      expect(
        (
          await ctx.http().get('/legal-documents').set(bearer(actor.token))
        ).status,
      ).toBe(200);
    }
    expect(
      (
        await ctx
          .http()
          .get('/legal-documents')
          .set(bearer(fx.employee.token))
      ).status,
    ).toBe(403);
    expect((await ctx.http().get('/legal-documents')).status).toBe(401);
  });

  it('VISA-API-07: an employee sees their own documents and no-one else’s', async () => {
    const own = await ctx
      .http()
      .get(`/legal-documents/employee/${fx.employee.employeeId}`)
      .set(bearer(fx.employee.token));
    expect(own.status).toBe(200);

    const other = await ctx
      .http()
      .get(`/legal-documents/employee/${fx.visaHolderId}`)
      .set(bearer(fx.employee.token));
    expect(other.status).toBe(403);
    expect(body(other)).toContain('only view your own');
  });

  it('VISA-API-08: a MANAGER is department-scoped and a scoped HR is branch-scoped', async () => {
    const inScope = await ctx
      .http()
      .get(`/legal-documents/employee/${fx.visaHolderId}`)
      .set(bearer(fx.manager.token));
    expect(inScope.status).toBe(200);

    const outOfScope = await ctx
      .http()
      .get(`/legal-documents/employee/${fx.staffBranchBId}`)
      .set(bearer(fx.manager.token));
    expect(outOfScope.status).toBe(403);

    const offGrant = await ctx
      .http()
      .get(`/legal-documents/${fx.currentVisaId}`)
      .set(bearer(fx.hr.token));
    expect(offGrant.status).toBe(200);
  });

  it('VISA-API-09: expiring and summary answer ADMIN/HR only', async () => {
    const expiring = await ctx
      .http()
      .get('/legal-documents/expiring?days=30')
      .set(bearer(fx.hr.token));
    expect(expiring.status).toBe(200);

    const summary = await ctx
      .http()
      .get('/legal-documents/summary')
      .set(bearer(fx.hr.token));
    expect(summary.status).toBe(200);

    for (const path of ['/legal-documents/expiring', '/legal-documents/summary']) {
      expect(
        (await ctx.http().get(path).set(bearer(fx.manager.token))).status,
      ).toBe(403);
    }
  });

  it('VISA-API-09b: the expiring window includes the fixture visa at 20 days', async () => {
    const inside = await ctx
      .http()
      .get('/legal-documents/expiring?days=30')
      .set(bearer(fx.hr.token));
    expect(rowsOf(inside).map((v) => v.id)).toContain(fx.currentVisaId);

    const outside = await ctx
      .http()
      .get('/legal-documents/expiring?days=7')
      .set(bearer(fx.hr.token));
    expect(rowsOf(outside).map((v) => v.id)).not.toContain(fx.currentVisaId);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // The renewal chain
  // ───────────────────────────────────────────────────────────────────────────

  it('VISA-API-29: nationality is optional, stored as an ISO-3166 alpha-2 code, and returned', async () => {
    const emp = await seedHolder();
    const withNationality = await create(newVisa(emp.id, { nationality: 'IN' }));
    expect(withNationality.status).toBe(201);
    expect(withNationality.body.data.nationality).toBe('IN');

    const withoutNationality = await create(newVisa(emp.id, { country: 'Qatar' }));
    expect(withoutNationality.status).toBe(201);
    expect(withoutNationality.body.data.nationality ?? null).toBeNull();
  });

  it('VISA-API-30: an invalid nationality code is refused', async () => {
    const emp = await seedHolder();
    const bad = await create(newVisa(emp.id, { nationality: 'India' }));
    expect(bad.status).toBe(400);
  });

  it('VISA-API-31: nationality edits on the current record and carries into a renewal', async () => {
    const emp = await seedHolder();
    const first = await create(
      newVisa(emp.id, { nationality: 'IN', expiryDate: daysFromNow(100) }),
    );

    const edited = await ctx
      .http()
      .patch(`/legal-documents/${first.body.data.id}`)
      .set(bearer(fx.hr.token))
      .send({ nationality: 'OM' });
    expect(edited.status).toBe(200);
    expect(edited.body.data.nationality).toBe('OM');

    const renewed = await ctx
      .http()
      .post(`/legal-documents/${first.body.data.id}/renew`)
      .set(bearer(fx.hr.token))
      .send({
        documentNumber: `VNN-${fx.runId}-${seq++}`,
        issueDate: daysFromNow(0),
        expiryDate: daysFromNow(500),
      });
    expect(renewed.status).toBe(201);
    expect(renewed.body.data.nationality).toBe('OM');
  });

  it('VISA-API-12: a renewal supersedes rather than overwrites', async () => {
    const emp = await seedHolder();
    const first = await create(newVisa(emp.id, { expiryDate: daysFromNow(100) }));
    const oldId = first.body.data.id;

    const res = await ctx
      .http()
      .post(`/legal-documents/${oldId}/renew`)
      .set(bearer(fx.hr.token))
      .send({
        documentNumber: `VNR-${fx.runId}-${seq++}`,
        issueDate: daysFromNow(0),
        expiryDate: daysFromNow(500),
      });
    expect(res.status).toBe(201);

    const old = await ctx.prisma.employeeLegalDocument.findUnique({
      where: { id: oldId },
    });
    expect(old!.status).toBe('RENEWED');
    expect(old!.isCurrent).toBe(false);

    const fresh = await ctx.prisma.employeeLegalDocument.findUnique({
      where: { id: res.body.data.id },
    });
    expect(fresh!.status).toBe('ACTIVE');
    expect(fresh!.isCurrent).toBe(true);
    expect(fresh!.renewedFromId).toBe(oldId);
  });

  it('VISA-API-13/14/15: renewal refuses a superseded, cancelled, or non-advancing record', async () => {
    const emp = await seedHolder();
    const first = await create(newVisa(emp.id, { expiryDate: daysFromNow(100) }));
    const renewed = await ctx
      .http()
      .post(`/legal-documents/${first.body.data.id}/renew`)
      .set(bearer(fx.hr.token))
      .send({
        documentNumber: `VNR2-${fx.runId}-${seq++}`,
        issueDate: daysFromNow(0),
        expiryDate: daysFromNow(400),
      });

    // The superseded record is history and cannot be renewed again.
    const again = await ctx
      .http()
      .post(`/legal-documents/${first.body.data.id}/renew`)
      .set(bearer(fx.hr.token))
      .send({
        documentNumber: `VNR3-${fx.runId}-${seq++}`,
        issueDate: daysFromNow(0),
        expiryDate: daysFromNow(600),
      });
    expect(again.status).toBe(400);
    expect(body(again)).toContain('Only the current record can be renewed');

    // A renewal has to move the expiry forward, or it is not a renewal.
    const backwards = await ctx
      .http()
      .post(`/legal-documents/${renewed.body.data.id}/renew`)
      .set(bearer(fx.hr.token))
      .send({
        documentNumber: `VNR4-${fx.runId}-${seq++}`,
        issueDate: daysFromNow(0),
        expiryDate: daysFromNow(100),
      });
    expect(backwards.status).toBe(400);
    expect(body(backwards)).toContain('after the previous expiry date');
  });

  it('VISA-API-16: a three-deep chain leaves exactly one current record', async () => {
    const emp = await seedHolder();
    const first = await create(newVisa(emp.id, { expiryDate: daysFromNow(100) }));
    let currentId = first.body.data.id;

    for (let i = 1; i <= 3; i++) {
      const res = await ctx
        .http()
        .post(`/legal-documents/${currentId}/renew`)
        .set(bearer(fx.hr.token))
        .send({
          documentNumber: `VNC-${fx.runId}-${seq++}`,
          issueDate: daysFromNow(0),
          expiryDate: daysFromNow(100 + i * 200),
        });
      expect(res.status).toBe(201);
      currentId = res.body.data.id;
    }

    const chain = await ctx.prisma.employeeLegalDocument.findMany({
      where: { employeeId: emp.id },
    });
    expect(chain).toHaveLength(4);
    expect(chain.filter((c) => c.isCurrent)).toHaveLength(1);
    expect(chain.find((c) => c.isCurrent)!.id).toBe(currentId);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Edit, cancel, and the state guards
  // ───────────────────────────────────────────────────────────────────────────

  it('VISA-API-10/11: a current record edits; a superseded one does not', async () => {
    const emp = await seedHolder();
    const first = await create(newVisa(emp.id, { expiryDate: daysFromNow(100) }));

    const ok = await ctx
      .http()
      .patch(`/legal-documents/${first.body.data.id}`)
      .set(bearer(fx.hr.token))
      .send({ remarks: 'Corrected sponsor name' });
    expect(ok.status).toBe(200);

    await ctx
      .http()
      .post(`/legal-documents/${first.body.data.id}/renew`)
      .set(bearer(fx.hr.token))
      .send({
        documentNumber: `VNE-${fx.runId}-${seq++}`,
        issueDate: daysFromNow(0),
        expiryDate: daysFromNow(400),
      });

    const refused = await ctx
      .http()
      .patch(`/legal-documents/${first.body.data.id}`)
      .set(bearer(fx.hr.token))
      .send({ remarks: 'Too late' });
    expect(refused.status).toBe(400);
    expect(body(refused)).toContain('historical');
  });

  it('VISA-API-17/18: cancel is terminal, and it frees the current slot', async () => {
    const emp = await seedHolder();
    const first = await create(newVisa(emp.id, { country: 'Qatar' }));

    const cancelled = await ctx
      .http()
      .post(`/legal-documents/${first.body.data.id}/cancel`)
      .set(bearer(fx.hr.token))
      .send({ reason: 'Employee never travelled' });
    expect(cancelled.status).toBe(201);

    const again = await ctx
      .http()
      .post(`/legal-documents/${first.body.data.id}/cancel`)
      .set(bearer(fx.hr.token))
      .send({ reason: 'Again' });
    expect(again.status).toBe(400);
    expect(body(again)).toContain('already cancelled');

    // A cancelled record is not renewable. Note WHICH refusal answers: cancel
    // also clears `isCurrent`, so the is-current guard fires first and the
    // dedicated message ('Cancelled records cannot be renewed — create a new
    // record') is unreachable through this path. The refusal is correct; the
    // sentence the author wrote for it never reaches a user.
    const renew = await ctx
      .http()
      .post(`/legal-documents/${first.body.data.id}/renew`)
      .set(bearer(fx.hr.token))
      .send({
        documentNumber: `VNX-${fx.runId}-${seq++}`,
        issueDate: daysFromNow(0),
        expiryDate: daysFromNow(400),
      });
    expect(renew.status).toBe(400);
    expect(body(renew)).toContain('Only the current record can be renewed');

    // And the slot it held is free again.
    const replacement = await create(newVisa(emp.id, { country: 'Qatar' }));
    expect(replacement.status).toBe(201);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Attachments
  // ───────────────────────────────────────────────────────────────────────────

  it('VISA-API-20/21: attachments upload, list, and refuse an oversize file', async () => {
    const emp = await seedHolder();
    const visa = await create(newVisa(emp.id));
    const id = visa.body.data.id;

    const ok = await ctx
      .http()
      .post(`/legal-documents/${id}/attachments`)
      .set(bearer(fx.hr.token))
      .attach('file', Buffer.alloc(1024, 1), {
        filename: 'visa.pdf',
        contentType: 'application/pdf',
      });
    expect([200, 201]).toContain(ok.status);

    const list = await ctx
      .http()
      .get(`/legal-documents/${id}/attachments`)
      .set(bearer(fx.hr.token));
    expect(list.status).toBe(200);
    expect(rowsOf(list).length).toBeGreaterThanOrEqual(1);

    const huge = await ctx
      .http()
      .post(`/legal-documents/${id}/attachments`)
      .set(bearer(fx.hr.token))
      .attach('file', Buffer.alloc(11 * 1024 * 1024, 1), {
        filename: 'huge.pdf',
        contentType: 'application/pdf',
      });
    expect(huge.status).toBeGreaterThanOrEqual(400);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Write RBAC and the ADMIN-only delete
  // ───────────────────────────────────────────────────────────────────────────

  it('VISA-API-22: every write door is closed to MANAGER and EMPLOYEE', async () => {
    const emp = await seedHolder();
    const visa = await create(newVisa(emp.id));
    const id = visa.body.data.id;

    for (const actor of [fx.manager, fx.employee]) {
      expect((await create(newVisa(emp.id), actor.token)).status).toBe(403);
      expect(
        (
          await ctx
            .http()
            .patch(`/legal-documents/${id}`)
            .set(bearer(actor.token))
            .send({ remarks: 'no' })
        ).status,
      ).toBe(403);
      expect(
        (
          await ctx
            .http()
            .post(`/legal-documents/${id}/cancel`)
            .set(bearer(actor.token))
            .send({ reason: 'no' })
        ).status,
      ).toBe(403);
      expect(
        (
          await ctx
            .http()
            .post(`/legal-documents/${id}/renew`)
            .set(bearer(actor.token))
            .send({
              documentNumber: 'X',
              issueDate: daysFromNow(0),
              expiryDate: daysFromNow(400),
            })
        ).status,
      ).toBe(403);
    }
  });

  it('VISA-API-23/26: only ADMIN may hard-delete, and the chain goes with it (P10)', async () => {
    const emp = await seedHolder();
    const first = await create(newVisa(emp.id, { expiryDate: daysFromNow(100) }));
    const renewed = await ctx
      .http()
      .post(`/legal-documents/${first.body.data.id}/renew`)
      .set(bearer(fx.hr.token))
      .send({
        documentNumber: `VND-${fx.runId}-${seq++}`,
        issueDate: daysFromNow(0),
        expiryDate: daysFromNow(400),
      });

    for (const actor of [fx.hr, fx.manager, fx.employee]) {
      expect(
        (
          await ctx
            .http()
            .delete(`/legal-documents/${renewed.body.data.id}`)
            .set(bearer(actor.token))
        ).status,
      ).toBe(403);
    }

    // ADMIN-only, and — unlike the employee hard delete — behind no setting at
    // all. The blast radius is recorded here so it is a known quantity.
    const res = await ctx
      .http()
      .delete(`/legal-documents/${renewed.body.data.id}`)
      .set(bearer(fx.admin.token));
    expect(res.status).toBe(200);

    expect(
      await ctx.prisma.employeeLegalDocument.findUnique({
        where: { id: renewed.body.data.id },
      }),
    ).toBeNull();
    // The record it superseded survives, now orphaned as the newest thing left.
    const survivor = await ctx.prisma.employeeLegalDocument.findUnique({
      where: { id: first.body.data.id },
    });
    expect(survivor).toBeTruthy();
    expect(survivor!.status).toBe('RENEWED');
    expect(survivor!.isCurrent).toBe(false);
  });

  /**
   * The partial unique index is the enforcement here, not the service — two
   * concurrent creates both pass the application-level check.
   *
   * This case is also why `prisma/e2e-partial-indexes.sql` exists: `db push`
   * cannot create a partial unique index, so the test template originally had
   * none of them and this assertion failed with TWO current visas — a state
   * DEV and PROD make impossible. The gap was in the harness, not the product.
   */
  it('VISA-API-28: two parallel creates for one employee+country leave exactly one', async () => {
    const emp = await seedHolder();
    const payload = newVisa(emp.id, { country: 'Bahrain' });
    const [a, b] = await Promise.all([
      create({ ...payload }),
      create({ ...payload, documentNumber: `${payload.documentNumber}-B` }),
    ]);
    expect([a.status, b.status].filter((s) => s === 201)).toHaveLength(1);

    const rows = await ctx.prisma.employeeLegalDocument.findMany({
      where: { employeeId: emp.id, country: 'Bahrain', isCurrent: true },
    });
    expect(rows).toHaveLength(1);
  });
});

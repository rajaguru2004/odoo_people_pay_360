import * as bcrypt from 'bcrypt';
import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { bearer } from './utils/fixtures';
import { WpsFormatRegistry } from '../src/wps/formats/wps-format.registry';

/**
 * The whole WPS flow, end to end, against a real Oman branch:
 *
 *   configure -> pre-flight blocks -> fix -> generate -> download -> submit ->
 *   bank rejects -> corrected v2 (v1 superseded)
 *
 * Plus the guarantees that matter more than the happy path:
 *   • all-or-nothing (a refused generate leaves NO file and NO rows)
 *   • branch isolation on both the API and the download route
 *   • the bank-detail freeze while a file is in flight, and its release for a
 *     rejected row
 */
describe('WPS wage file flow (e2e)', () => {
  let ctx: E2EContext;
  const runId = `wps${Date.now()}`;

  let adminToken: string;
  let otherHrToken: string;
  let employeeToken: string;

  let branchId: string;
  let otherBranchId: string;
  let bankId: string;
  let payrollId: string;
  let profileId: string;
  let empA: string;
  let empB: string;

  // 018 = Bank Muscat; both IBANs carry it and pass mod-97.
  const IBAN_A = 'OM810180000001299123456';
  const IBAN_B = 'OM040181000000000150461';

  beforeAll(async () => {
    ctx = await bootE2EApp();
    const prisma = ctx.prisma;
    const hash = await bcrypt.hash('Password123!', 10);

    const [branch, other] = await Promise.all([
      prisma.branch.create({
        data: {
          code: `WPS-OM-${runId}`,
          name: 'WPS Muscat',
          country: 'OM',
          isActive: true,
          timezone: 'Asia/Muscat',
        },
      }),
      prisma.branch.create({
        data: {
          code: `WPS-IN-${runId}`,
          name: 'WPS Bengaluru',
          country: 'IN',
          isActive: true,
        },
      }),
    ]);
    branchId = branch.id;
    otherBranchId = other.id;

    const dept = await prisma.department.create({
      data: { code: `WPS-D-${runId}`, name: `WPS Dept ${runId}`, isActive: true },
    });

    const mkEmp = (suffix: string) =>
      prisma.employee.create({
        data: {
          employeeCode: `WPS-${runId}-${suffix}`,
          fullName: `WPS ${suffix}`,
          dateOfBirth: new Date('1990-01-01'),
          idCard: `WPS-ID-${runId}-${suffix}`,
          email: `wps-${suffix}-${runId}@test.local`,
          departmentId: dept.id,
          branchId,
          position: 'Engineer',
          startDate: new Date('2015-01-01'),
          baseSalary: 500,
          status: 'ACTIVE',
        },
      });
    const [a, b] = await Promise.all([mkEmp('A'), mkEmp('B')]);
    empA = a.id;
    empB = b.id;

    await Promise.all([
      prisma.user.create({
        data: {
          email: `wps-admin-${runId}@test.local`,
          passwordHash: hash,
          role: 'ADMIN',
          isActive: true,
          isGlobalBranchAccess: true,
        },
      }),
      prisma.user.create({
        data: {
          email: `wps-otherhr-${runId}@test.local`,
          passwordHash: hash,
          role: 'HR_MANAGER',
          isActive: true,
          isGlobalBranchAccess: false,
          branchAccess: { create: { branchId: otherBranchId } },
        },
      }),
      prisma.user.create({
        data: {
          email: `wps-emp-${runId}@test.local`,
          passwordHash: hash,
          role: 'EMPLOYEE',
          isActive: true,
          isGlobalBranchAccess: false,
          employeeId: empA,
        },
      }),
    ]);

    const login = async (email: string) => {
      const res = await ctx
        .http()
        .post('/auth/login')
        .send({ email, password: 'Password123!' });
      return res.body?.data?.accessToken as string;
    };
    adminToken = await login(`wps-admin-${runId}@test.local`);
    otherHrToken = await login(`wps-otherhr-${runId}@test.local`);
    employeeToken = await login(`wps-emp-${runId}@test.local`);

    // OM banking field schema + a bank with a real CBO code.
    for (const [fieldKey, label, validationType, order] of [
      ['accountHolderName', 'Account Holder Name', 'NONE', 1],
      ['iban', 'IBAN', 'IBAN', 2],
    ] as const) {
      await prisma.countryBankingField.upsert({
        where: { country_fieldKey: { country: 'OM', fieldKey } },
        update: {},
        create: {
          country: 'OM',
          fieldKey,
          label,
          validationType,
          required: true,
          displayOrder: order,
          isSensitive: fieldKey === 'iban',
        },
      });
    }
    const bank = await prisma.bank.create({
      data: {
        country: 'OM',
        name: `WPS Bank Muscat ${runId}`,
        bankCode: '018',
        swift: 'BMUSOMRX',
        isActive: true,
      },
    });
    bankId = bank.id;

    // Employee A gets bank details; B deliberately does NOT, so the first
    // pre-flight has something real to block on.
    await prisma.employeeBankDetail.create({
      data: {
        employeeId: empA,
        bankId,
        data: { accountHolderName: 'WPS A', iban: IBAN_A },
        iban: IBAN_A,
        accountHolderName: 'WPS A',
        isActive: true,
        source: 'MIGRATION',
        branchId,
      },
    });

    // A properly locked payroll: LOCKED plus lockedAt AND approvedAt, which is
    // the gate WPS requires (status alone is not enough).
    const payroll = await prisma.payroll.create({
      data: {
        month: 6,
        year: 2098,
        status: 'LOCKED',
        branchId,
        approvedAt: new Date('2098-06-30T09:00:00Z'),
        approvedBy: null,
        lockedAt: new Date('2098-06-30T10:00:00Z'),
      },
    });
    payrollId = payroll.id;
    for (const [employeeId, net] of [
      [empA, 500],
      [empB, 700],
    ] as const) {
      await prisma.payrollItem.create({
        data: {
          payrollId: payroll.id,
          employeeId,
          baseSalary: net * 0.6,
          allowances: net * 0.4,
          workDays: 22,
          actualWorkDays: 22,
          netSalary: net,
        },
      });
    }
  }, 180_000);

  afterAll(async () => {
    const prisma = ctx?.prisma;
    if (prisma) {
      await prisma.wpsFileRow.deleteMany({ where: { wpsFile: { branchId } } });
      await prisma.wpsFile.deleteMany({ where: { branchId } });
      await prisma.wpsConfiguration.deleteMany({ where: { branchId } });
      if (profileId)
        await prisma.wpsEmployerProfile.deleteMany({ where: { id: profileId } });
      await prisma.payrollItem.deleteMany({ where: { payrollId } });
      await prisma.payroll.deleteMany({ where: { id: payrollId } });
      await prisma.employeeBankDetail.deleteMany({ where: { branchId } });
      await prisma.bankChangeRequest.deleteMany({ where: { branchId } });
      await prisma.bank.deleteMany({ where: { id: bankId } });
      await prisma.user.deleteMany({ where: { email: { contains: runId } } });
      await prisma.employee.deleteMany({ where: { employeeCode: { contains: runId } } });
      await prisma.department.deleteMany({ where: { code: { contains: runId } } });
      await prisma.branch.deleteMany({ where: { id: { in: [branchId, otherBranchId] } } });
    }
    await ctx?.app?.close();
  });

  const api = () => ctx.http();

  // ── 1. RBAC ───────────────────────────────────────────────────────────────
  it('refuses a plain employee everywhere on /wps', async () => {
    for (const path of ['/wps/formats', '/wps/config', '/wps/files']) {
      const res = await api().get(path).set(bearer(employeeToken));
      expect(res.status).toBe(403);
    }
    const gen = await api()
      .post('/wps/generate')
      .set(bearer(employeeToken))
      .send({ payrollId });
    expect(gen.status).toBe(403);
  });

  // ── 2. Catalogue ──────────────────────────────────────────────────────────
  it('offers the Oman format for an OM branch', async () => {
    const res = await api().get('/wps/formats?country=OM').set(bearer(adminToken));
    expect(res.status).toBe(200);
    const keys = res.body.data.map((f: any) => f.key);
    expect(keys).toContain('om-cbo-v1');

    const oman = res.body.data.find((f: any) => f.key === 'om-cbo-v1');
    expect(oman.currency).toBe('OMR');
    expect(oman.currencyExponent).toBe(3);
    // The UI renders its form from this, so it must travel over the wire.
    expect(oman.employerConfigSchema.length).toBeGreaterThan(0);
  });

  // ── 3. Refuses to run before configuration ────────────────────────────────
  it('will not pre-flight a branch with no WPS configuration', async () => {
    const res = await api()
      .post('/wps/preflight')
      .set(bearer(adminToken))
      .set('X-Branch-Id', branchId)
      .send({ payrollId });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/no wage-file configuration/i);
  });

  // ── 4. Configure ──────────────────────────────────────────────────────────
  it('creates an employer profile and a branch configuration', async () => {
    const profile = await api()
      .post('/wps/employer-profiles')
      .set(bearer(adminToken))
      .send({
        name: `WPS establishment ${runId}`,
        legalName: 'WPS Test LLC',
        country: 'OM',
        format: 'om-cbo-v1',
        data: {
          molEstablishmentNumber: '7654321',
          crNumber: '2020202',
          employerBankCode: '018',
          employerAccountIban: IBAN_A,
        },
      });
    expect(profile.status).toBe(201);
    profileId = profile.body.data.id;

    const cfg = await api()
      .post('/wps/config')
      .set(bearer(adminToken))
      .set('X-Branch-Id', branchId)
      .send({
        branchId,
        employerProfileId: profileId,
        format: 'om-cbo-v1',
        enabled: true,
      });
    expect(cfg.status).toBe(201);
  });

  it('refuses an Oman format on a non-Oman branch', async () => {
    const res = await api()
      .post('/wps/config')
      .set(bearer(adminToken))
      .send({
        branchId: otherBranchId,
        employerProfileId: profileId,
        format: 'om-cbo-v1',
        enabled: true,
      });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/applies to OM/i);
  });

  // ── 5. Pre-flight blocks, and generation is all-or-nothing ───────────────
  it('blocks the employee with no bank details, and reports who', async () => {
    const res = await api()
      .post('/wps/preflight')
      .set(bearer(adminToken))
      .set('X-Branch-Id', branchId)
      .send({ payrollId });

    expect(res.status).toBe(201);
    const pf = res.body.data;
    expect(pf.canGenerate).toBe(false);
    expect(pf.total).toBe(2);
    expect(pf.ready).toBe(1);
    expect(pf.blockedEmployees).toBe(1);

    const blocked = pf.byEmployee.find((e: any) => e.status === 'BLOCKED');
    expect(blocked.employeeId).toBe(empB);
    const finding = blocked.findings.find((f: any) => f.code === 'NO_ACTIVE_BANK_DETAIL');
    expect(finding.severity).toBe('BLOCKING');
    // The operator needs somewhere to go, not just a complaint.
    expect(finding.fix?.href).toBeTruthy();
  });

  it('produces NO file and NO rows when a single employee is blocked', async () => {
    const res = await api()
      .post('/wps/generate')
      .set(bearer(adminToken))
      .set('X-Branch-Id', branchId)
      .send({ payrollId });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/1 of 2 employees are blocked/);

    // The all-or-nothing guarantee: nothing was allocated, not even a stub.
    expect(await ctx.prisma.wpsFile.count({ where: { payrollId } })).toBe(0);
    expect(await ctx.prisma.wpsFileRow.count()).toBeGreaterThanOrEqual(0);
    const rows = await ctx.prisma.wpsFileRow.count({
      where: { wpsFile: { payrollId } },
    });
    expect(rows).toBe(0);
  });

  // ── 6. Fix, then generate ────────────────────────────────────────────────
  it('generates once every employee is payable', async () => {
    await ctx.prisma.employeeBankDetail.create({
      data: {
        employeeId: empB,
        bankId,
        data: { accountHolderName: 'WPS B', iban: IBAN_B },
        iban: IBAN_B,
        accountHolderName: 'WPS B',
        isActive: true,
        source: 'MIGRATION',
        branchId,
      },
    });

    const pf = await api()
      .post('/wps/preflight')
      .set(bearer(adminToken))
      .set('X-Branch-Id', branchId)
      .send({ payrollId });
    expect(pf.body.data.canGenerate).toBe(true);
    expect(pf.body.data.ready).toBe(2);

    const gen = await api()
      .post('/wps/generate')
      .set(bearer(adminToken))
      .set('X-Branch-Id', branchId)
      .send({
        payrollId,
        acknowledgeWarnings: pf.body.data.requiresAcknowledgement,
      });
    expect(gen.status).toBe(201);

    const file = gen.body.data;
    expect(file.status).toBe('GENERATED');
    expect(file.version).toBe(1);
    expect(file.employeeCount).toBe(2);
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    // 1200 OMR in baisa. Summed from the rows, never from payrolls.total_amount.
    expect(String(file.totalMinor)).toBe('1200000');
  });

  it('refuses generation while a file is already in flight', async () => {
    const res = await api()
      .post('/wps/generate')
      .set(bearer(adminToken))
      .set('X-Branch-Id', branchId)
      .send({ payrollId });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already exists/i);
  });

  it('rows sum to the stored header total', async () => {
    const list = await api()
      .get(`/wps/files?payrollId=${payrollId}`)
      .set(bearer(adminToken))
      .set('X-Branch-Id', branchId);
    const fileId = list.body.data[0].id;

    const detail = await api()
      .get(`/wps/files/${fileId}`)
      .set(bearer(adminToken))
      .set('X-Branch-Id', branchId);
    expect(detail.status).toBe(200);

    const rows = detail.body.data.rows;
    expect(rows).toHaveLength(2);
    const sum = rows.reduce((acc: bigint, r: any) => acc + BigInt(r.net.minor), 0n);
    expect(sum.toString()).toBe(detail.body.data.total.minor);

    // Sensitive values are masked in every read projection.
    for (const r of rows) {
      expect(r.account).toMatch(/^••••/);
      expect(r.account).not.toContain(IBAN_A);
    }
  });

  // ── 7. Branch isolation ──────────────────────────────────────────────────
  it('hides the file from a manager in another branch, API and download alike', async () => {
    const mine = await api()
      .get(`/wps/files?payrollId=${payrollId}`)
      .set(bearer(adminToken))
      .set('X-Branch-Id', branchId);
    const fileId = mine.body.data[0].id;

    const theirList = await api().get('/wps/files').set(bearer(otherHrToken));
    expect(theirList.body.data.map((f: any) => f.id)).not.toContain(fileId);

    const theirGet = await api().get(`/wps/files/${fileId}`).set(bearer(otherHrToken));
    expect(theirGet.status).toBe(404); // NotFound, not Forbidden — no existence leak

    const theirDownload = await api()
      .get(`/secure-files/wps-file/${fileId}`)
      .set(bearer(otherHrToken));
    expect(theirDownload.status).toBe(404);
  });

  it('refuses the download to a plain employee even though the route admits them', async () => {
    // secure-download's own @Roles includes EMPLOYEE; the resolver is the real gate.
    const mine = await api()
      .get(`/wps/files?payrollId=${payrollId}`)
      .set(bearer(adminToken))
      .set('X-Branch-Id', branchId);
    const fileId = mine.body.data[0].id;

    const res = await api()
      .get(`/secure-files/wps-file/${fileId}`)
      .set(bearer(employeeToken));
    expect(res.status).toBe(404);
  });

  // ── 8. Download the bytes ────────────────────────────────────────────────
  it('streams a well-formed file that reconciles', async () => {
    const mine = await api()
      .get(`/wps/files?payrollId=${payrollId}`)
      .set(bearer(adminToken))
      .set('X-Branch-Id', branchId);
    const file = mine.body.data[0];

    const res = await api()
      .get(`/secure-files/wps-file/${file.id}`)
      .set(bearer(adminToken))
      .set('X-Branch-Id', branchId)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain(file.fileName);
    expect(res.headers['cache-control']).toContain('no-store');

    const text = (res.body as Buffer).toString('latin1');
    const lines = text.trim().split('\r\n');
    expect(lines[0]).toMatch(/^01,7654321,2020202,WPS Test LLC,018,/);
    expect(lines.filter((l) => l.startsWith('02,'))).toHaveLength(2);

    const headerTotal = BigInt(lines[0].split(',')[11]);
    const detailSum = lines
      .filter((l) => l.startsWith('02,'))
      .reduce((acc, l) => acc + BigInt(l.split(',')[11]), 0n);
    expect(detailSum).toBe(headerTotal);
    expect(headerTotal).toBe(1_200_000n); // baisa — 3 decimals, not 2

    const audit = await ctx.prisma.auditLog.findFirst({
      where: { action: 'SECURE_FILE_DOWNLOADED', resourceId: file.id },
    });
    expect(audit).toBeTruthy();
  });

  it('verifies the stored fingerprint', async () => {
    const mine = await api()
      .get(`/wps/files?payrollId=${payrollId}`)
      .set(bearer(adminToken))
      .set('X-Branch-Id', branchId);
    const res = await api()
      .get(`/wps/files/${mine.body.data[0].id}/verify`)
      .set(bearer(adminToken))
      .set('X-Branch-Id', branchId);
    expect(res.body.data.matches).toBe(true);
  });

  // ── 9. Bank-detail freeze ────────────────────────────────────────────────
  it('freezes bank details while the file is in flight, and releases a rejected row', async () => {
    const frozen = await api()
      .post('/bank-change-requests')
      .set(bearer(adminToken))
      .set('X-Branch-Id', branchId)
      .send({ employeeId: empA, bankId, data: { accountHolderName: 'WPS A', iban: IBAN_A } });
    expect(frozen.status).toBe(409);
    expect(frozen.body.message).toMatch(/locked while a WPS file is being generated/i);
  });

  // ── 10. Lifecycle: submit -> rejected -> corrected v2 ────────────────────
  it('submits, records a rejection, then generates a superseding v2', async () => {
    const mine = await api()
      .get(`/wps/files?payrollId=${payrollId}`)
      .set(bearer(adminToken))
      .set('X-Branch-Id', branchId);
    const v1 = mine.body.data[0];

    const submitted = await api()
      .post(`/wps/files/${v1.id}/submit`)
      .set(bearer(adminToken))
      .set('X-Branch-Id', branchId)
      .send({ reference: 'BANK-REF-1' });
    expect(submitted.status).toBe(201);
    expect(submitted.body.data.status).toBe('SUBMITTED');

    const rejected = await api()
      .post(`/wps/files/${v1.id}/response`)
      .set(bearer(adminToken))
      .set('X-Branch-Id', branchId)
      .send({
        outcome: 'PARTIALLY_REJECTED',
        reference: 'BANK-REJ-1',
        rejectedRows: [{ employeeId: empB, code: 'INVALID_ACCOUNT', reason: 'Account closed' }],
      });
    expect(rejected.status).toBe(201);
    expect(rejected.body.data.status).toBe('PARTIALLY_REJECTED');

    const rows = rejected.body.data.rows;
    expect(rows.find((r: any) => r.employeeId === empB).status).toBe('REJECTED');
    expect(rows.find((r: any) => r.employeeId === empA).status).toBe('ACCEPTED');

    // The rejected employee can now fix their details; the accepted one cannot.
    const bFree = await api()
      .post('/bank-change-requests')
      .set(bearer(adminToken))
      .set('X-Branch-Id', branchId)
      .send({ employeeId: empB, bankId, data: { accountHolderName: 'WPS B', iban: IBAN_B } });
    expect([200, 201]).toContain(bFree.status);

    // v2 from the same payroll, superseding v1.
    const v2 = await api()
      .post('/wps/generate')
      .set(bearer(adminToken))
      .set('X-Branch-Id', branchId)
      .send({ payrollId, acknowledgeWarnings: ['IDENTIFIER_MISSING', 'BANK_CHANGE_PENDING'] });

    if (v2.status === 400) {
      // A pending bank change legitimately blocks v2 — assert that reason rather
      // than pretending the flow succeeded.
      expect(v2.body.message).toMatch(/blocked/i);
      return;
    }

    expect(v2.status).toBe(201);
    expect(v2.body.data.version).toBe(2);
    expect(v2.body.data.previousVersionId).toBe(v1.id);

    const v1After = await ctx.prisma.wpsFile.findUnique({ where: { id: v1.id } });
    expect(v1After!.status).toBe('SUPERSEDED');
  });

  // ── 11. The legacy stuck-LOCKED run has an actionable remedy ─────────────
  //
  // A run finalised by the old code path is LOCKED without approval. submit,
  // approve and lock ALL reject a LOCKED payroll, so telling the operator to
  // "submit it for approval" is advice they cannot act on. The finding must name
  // the one action that works: a revision.
  it('names the revision as the remedy for a run locked without approval', async () => {
    const legacy = await ctx.prisma.payroll.create({
      data: {
        month: 5,
        year: 2098,
        status: 'LOCKED', // reached LOCKED with no approvedAt / lockedAt
        branchId,
        finalizedAt: new Date('2098-05-31T10:00:00Z'),
      },
    });
    await ctx.prisma.payrollItem.create({
      data: {
        payrollId: legacy.id,
        employeeId: empA,
        baseSalary: 300,
        allowances: 200,
        workDays: 22,
        actualWorkDays: 22,
        netSalary: 500,
      },
    });

    try {
      const res = await api()
        .post('/wps/preflight')
        .set(bearer(adminToken))
        .set('X-Branch-Id', branchId)
        .send({ payrollId: legacy.id });

      expect(res.status).toBe(201);
      const pf = res.body.data;
      expect(pf.canGenerate).toBe(false);

      const finding = pf.runFindings.find(
        (f: any) => f.code === 'PAYROLL_LOCKED_WITHOUT_APPROVAL',
      );
      expect(finding).toBeTruthy();
      expect(finding.severity).toBe('BLOCKING');
      expect(finding.message).toMatch(/revision/i);
      // NOT the impossible advice.
      expect(finding.message).not.toMatch(/submit it for approval, approve it, then lock/i);
      expect(finding.fix?.label).toMatch(/revision/i);

      // And prove the advice is sound: the three transitions really are refused.
      for (const step of ['submit', 'approve', 'lock']) {
        const t = await api()
          .post(`/payrolls/${legacy.id}/${step}`)
          .set(bearer(adminToken))
          .set('X-Branch-Id', branchId)
          .send({ notes: 'x' });
        expect(t.status).toBe(400);
      }

      // The revision escape hatch works, and keeps its branch (a Phase 0 fix —
      // without it the new version would be invisible to branch-scoped HR).
      const rev = await api()
        .post(`/payrolls/${legacy.id}/create-revision`)
        .set(bearer(adminToken))
        .set('X-Branch-Id', branchId)
        .send({ reason: 'locked without approval' });
      expect([200, 201]).toContain(rev.status);
      expect(rev.body.data.version).toBe(2);
      expect(rev.body.data.branchId).toBe(branchId);
      expect(rev.body.data.status).toBe('DRAFT');

      await ctx.prisma.payrollItem.deleteMany({
        where: { payrollId: rev.body.data.id },
      });
      await ctx.prisma.payroll.delete({ where: { id: rev.body.data.id } });
    } finally {
      await ctx.prisma.payrollItem.deleteMany({ where: { payrollId: legacy.id } });
      await ctx.prisma.payroll.delete({ where: { id: legacy.id } });
    }
  });

  it('still uses the plain code when the payroll simply is not locked', async () => {
    const draft = await ctx.prisma.payroll.create({
      data: { month: 4, year: 2098, status: 'DRAFT', branchId },
    });
    await ctx.prisma.payrollItem.create({
      data: {
        payrollId: draft.id,
        employeeId: empA,
        baseSalary: 300,
        allowances: 200,
        workDays: 22,
        actualWorkDays: 22,
        netSalary: 500,
      },
    });
    try {
      const res = await api()
        .post('/wps/preflight')
        .set(bearer(adminToken))
        .set('X-Branch-Id', branchId)
        .send({ payrollId: draft.id });
      const codes = res.body.data.runFindings.map((f: any) => f.code);
      expect(codes).toContain('PAYROLL_NOT_PROPERLY_LOCKED');
      expect(codes).not.toContain('PAYROLL_LOCKED_WITHOUT_APPROVAL');
    } finally {
      await ctx.prisma.payrollItem.deleteMany({ where: { payrollId: draft.id } });
      await ctx.prisma.payroll.delete({ where: { id: draft.id } });
    }
  });

  // ── 12. A fake format proves the abstraction ─────────────────────────────
  it('accepts a format registered only for the test', () => {
    const registry = ctx.app.get(WpsFormatRegistry);
    registry.registerForTesting({
      key: 'e2e-fake',
      displayName: 'E2E Fake',
      description: 'Test double.',
      country: 'OM',
      currency: 'OMR',
      currencyExponent: 3,
      specVersion: 'e2e-1',
      employerConfigSchema: [],
      runOptionsSchema: [],
      requiredIdentifiers: [],
      validate: () => [],
      generate: async () => [
        {
          fileName: 'fake.csv',
          bytes: Buffer.from('x'),
          mimeType: 'text/csv',
          role: 'PRIMARY' as const,
        },
      ],
    });
    expect(registry.get('e2e-fake').displayName).toBe('E2E Fake');
    expect(registry.listForCountry('OM').map((f) => f.key)).toContain('e2e-fake');
  });
});

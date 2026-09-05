import * as bcrypt from 'bcrypt';
import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { readApprovalSwitch, restoreApprovalSwitch } from './utils/approval-switch';
import { bearer } from './utils/fixtures';

/**
 * End-to-end coverage for the dynamic, country-aware banking configuration:
 *   1. Country Banking Config CRUD (RBAC, create/update, active filter, delete).
 *   2. Per-branch allowed banking countries (multi) + how they surface to an
 *      employee (`/bank-change-requests/me/current`).
 *   3. A fully DYNAMIC submit end-to-end for a bespoke country "ZZ" (no hardcoded
 *      fields): validation from config, storage, and masking of sensitive values.
 *   4. Validation errors + cross-country bank rejection.
 *
 * Uses an isolated country code "ZZ" so it never touches the shipped OM/IN/… config.
 */
describe('Country Banking Config + dynamic bank details (e2e)', () => {
  let ctx: E2EContext;
  const PASSWORD = 'Passw0rd!';
  const runId = `cfg${Date.now()}`;
  // The approval master switch is SHARED, environment-wide config. Snapshot it
  // before forcing it off so a run never silently disables a configured chain.
  let originalSwitchValue: string | null = null;
  const CC = 'ZZ';

  const emails = {
    admin: `admin-${runId}@test.local`,
    employee: `emp-${runId}@test.local`,
  };

  let branchId: string;
  let employeeId: string;
  let adminToken: string;
  let employeeToken: string;

  beforeAll(async () => {
    ctx = await bootE2EApp();
    const { prisma } = ctx;
    const hash = await bcrypt.hash(PASSWORD, 10);

    const branch = await prisma.branch.create({
      data: {
        code: `CFG-BR-${runId}`,
        name: 'Cfg Branch',
        country: CC,
        isActive: true,
        timezone: 'Asia/Muscat',
        officeStartTime: '09:00',
        officeEndTime: '18:00',
      },
    });
    branchId = branch.id;

    const dept = await prisma.department.create({
      data: { code: `CFG-D-${runId}`, name: `Cfg Dept ${runId}`, isActive: true },
    });

    const emp = await prisma.employee.create({
      data: {
        employeeCode: `CFG-${runId}-E`,
        fullName: `Cfg Emp`,
        dateOfBirth: new Date('1990-01-01'),
        idCard: `CFG-ID-${runId}`,
        email: `person-${runId}@test.local`,
        departmentId: dept.id,
        branchId: branch.id,
        position: 'Engineer',
        startDate: new Date('2015-01-01'),
        baseSalary: 50000,
        status: 'ACTIVE',
      },
    });
    employeeId = emp.id;

    await prisma.user.create({
      data: { email: emails.admin, passwordHash: hash, role: 'ADMIN', isActive: true, isGlobalBranchAccess: true },
    });
    await prisma.user.create({
      data: {
        email: emails.employee,
        passwordHash: hash,
        role: 'EMPLOYEE',
        isActive: true,
        isGlobalBranchAccess: true,
        employeeId,
      },
    });

    // Approval engine off => submissions auto-apply (deterministic).
    originalSwitchValue = await readApprovalSwitch(prisma);
    await prisma.systemSetting.upsert({
      where: { key: 'supervisor_approval_enabled' },
      update: { value: 'false' },
      create: { key: 'supervisor_approval_enabled', value: 'false' },
    });

    const login = async (email: string) =>
      (await ctx.http().post('/auth/login').send({ email, password: PASSWORD }))
        .body?.data?.accessToken as string;
    [adminToken, employeeToken] = await Promise.all([login(emails.admin), login(emails.employee)]);
  });

  afterAll(async () => {
    const { prisma } = ctx;
    const empWhere = { employee: { employeeCode: { contains: runId } } };
    await prisma.employeeBankDetail.deleteMany({ where: empWhere });
    await prisma.bankChangeRequest.deleteMany({ where: empWhere });
    await prisma.bank.deleteMany({ where: { name: { contains: runId } } });
    await prisma.countryBankingField.deleteMany({ where: { country: CC } });
    await prisma.user.deleteMany({ where: { email: { contains: runId } } });
    await prisma.employee.deleteMany({ where: { employeeCode: { contains: runId } } });
    await prisma.department.deleteMany({ where: { code: { contains: runId } } });
    await prisma.branch.deleteMany({ where: { code: { contains: runId } } });
    await restoreApprovalSwitch(prisma, originalSwitchValue);
    await ctx.app.close();
  });

  const putField = (token: string, body: any) =>
    ctx.http().put('/banking-config').set(bearer(token)).send(body);

  // ── 1. Config CRUD + RBAC ─────────────────────────────────────────────
  it('EMPLOYEE cannot edit banking config (403); ADMIN can', async () => {
    const forbidden = await putField(employeeToken, {
      country: CC, fieldKey: 'x', label: 'X', validationType: 'NONE',
    });
    expect(forbidden.status).toBe(403);

    const ok = await putField(adminToken, {
      country: CC, fieldKey: 'accountHolderName', label: 'Account Holder Name',
      validationType: 'NONE', required: true, displayOrder: 1, isSensitive: false,
    });
    expect(ok.status).toBe(200);
  });

  it('ADMIN configures the ZZ field schema (ordered)', async () => {
    expect((await putField(adminToken, { country: CC, fieldKey: 'accountNumber', label: 'Account Number', validationType: 'NUMBER', required: true, displayOrder: 2, isSensitive: true })).status).toBe(200);
    expect((await putField(adminToken, { country: CC, fieldKey: 'acctCode', label: 'Account Code', validationType: 'REGEX', regex: '^[A-Z]{3}$', required: false, displayOrder: 3, isSensitive: false })).status).toBe(200);

    const fields = await ctx.http().get(`/banking-config/fields?country=${CC}`).set(bearer(employeeToken));
    expect(fields.body?.success).toBe(true);
    const keys = fields.body.data.map((f: any) => f.fieldKey);
    expect(keys).toEqual(['accountHolderName', 'accountNumber', 'acctCode']); // ordered by displayOrder
  });

  it('re-PUT updates an existing field (upsert by country+key)', async () => {
    const upd = await putField(adminToken, { country: CC, fieldKey: 'acctCode', label: 'Renamed Code', validationType: 'REGEX', regex: '^[A-Z]{3}$', displayOrder: 3 });
    expect(upd.status).toBe(200);
    const list = await ctx.http().get(`/banking-config?country=${CC}`).set(bearer(adminToken));
    const row = list.body.data.find((r: any) => r.fieldKey === 'acctCode');
    expect(row.label).toBe('Renamed Code');
  });

  it('inactive fields are excluded from the render endpoint but listed for admin, then deletable', async () => {
    await putField(adminToken, { country: CC, fieldKey: 'legacyRef', label: 'Legacy', validationType: 'NONE', isActive: false, displayOrder: 9 });
    const fields = await ctx.http().get(`/banking-config/fields?country=${CC}`).set(bearer(employeeToken));
    expect(fields.body.data.map((f: any) => f.fieldKey)).not.toContain('legacyRef');

    const list = await ctx.http().get(`/banking-config?country=${CC}`).set(bearer(adminToken));
    const legacy = list.body.data.find((r: any) => r.fieldKey === 'legacyRef');
    expect(legacy).toBeDefined();

    const del = await ctx.http().delete(`/banking-config/${legacy.id}`).set(bearer(adminToken));
    expect(del.status).toBe(200);
    const after = await ctx.http().get(`/banking-config?country=${CC}`).set(bearer(adminToken));
    expect(after.body.data.find((r: any) => r.fieldKey === 'legacyRef')).toBeUndefined();
  });

  // ── 2. Branch banking countries ───────────────────────────────────────
  it('sets multi banking countries on the branch and surfaces them to the employee', async () => {
    const set = await ctx.http().put(`/banks/branch-countries/${branchId}`).set(bearer(adminToken)).send({ countries: [CC, 'OM'] });
    expect(set.status).toBe(200);

    const branches = await ctx.http().get('/banks/branch-countries').set(bearer(adminToken));
    const b = branches.body.data.find((x: any) => x.id === branchId);
    expect(b.allowedCountries).toEqual(expect.arrayContaining([CC, 'OM']));

    const cur = await ctx.http().get('/bank-change-requests/me/current').set(bearer(employeeToken));
    expect(cur.body.data.countries).toEqual(expect.arrayContaining([CC, 'OM']));
  });

  // ── 3. Dynamic submit end-to-end + masking ────────────────────────────
  let zzBankId: string;
  it('employee submits dynamic ZZ details -> validated, stored, auto-applied', async () => {
    const bank = await ctx.http().post('/banks').set(bearer(adminToken)).send({ country: CC, name: `ZZ Bank ${runId}` });
    expect(bank.status).toBe(201);
    zzBankId = bank.body.data.id;

    const res = await ctx.http().post('/bank-change-requests').set(bearer(employeeToken)).send({
      bankId: zzBankId,
      data: { accountHolderName: 'Emp Z', accountNumber: '987654321', acctCode: 'ABC' },
    });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('APPROVED'); // switch off => auto-apply

    const detail = await ctx.prisma.employeeBankDetail.findFirst({ where: { employeeId, isActive: true } });
    expect(detail?.data).toMatchObject({ accountHolderName: 'Emp Z', accountNumber: '987654321', acctCode: 'ABC' });

    // Masking: accountNumber sensitive -> masked; accountHolderName not sensitive -> plain.
    const cur = await ctx.http().get('/bank-change-requests/me/current').set(bearer(employeeToken));
    expect(cur.body.data.detail.values.accountNumber).toBe('••••4321');
    expect(cur.body.data.detail.values.accountHolderName).toBe('Emp Z');
  });

  it('rejects invalid values with per-field errors (400)', async () => {
    const res = await ctx.http().post('/bank-change-requests').set(bearer(employeeToken)).send({
      bankId: zzBankId,
      data: { accountNumber: '12x', acctCode: 'abcd' }, // missing holder, bad number, bad regex
    });
    expect(res.status).toBe(400);
    const errors = res.body.errors;
    expect(errors.accountHolderName).toBeDefined();
    expect(errors.accountNumber).toBeDefined();
    expect(errors.acctCode).toBeDefined();
  });

  it('rejects a bank whose country is not allowed for the branch (400)', async () => {
    // Restrict the branch to ZZ only, then try an OM bank.
    await ctx.http().put(`/banks/branch-countries/${branchId}`).set(bearer(adminToken)).send({ countries: [CC] });
    const om = await ctx.http().post('/banks').set(bearer(adminToken)).send({ country: 'OM', name: `OM Bank ${runId}` });
    const res = await ctx.http().post('/bank-change-requests').set(bearer(employeeToken)).send({
      bankId: om.body.data.id,
      data: { accountHolderName: 'Emp Z', iban: 'OM810180000001299123456' },
    });
    expect(res.status).toBe(400);
  });
});

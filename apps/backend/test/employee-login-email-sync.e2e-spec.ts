import * as bcrypt from 'bcrypt';
import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { setupFixtures, Fixtures, bearer } from './utils/fixtures';
import { assertDevDb } from './utils/mcp-harness';

/**
 * Changing an employee's email must change the address they log in with.
 *
 * `employees.email` is where every credential mail goes; `users.email` is what
 * `AuthService.login` looks up. `EmployeesService.update` wrote the first and
 * never the second, so an edited address left the login row behind: the person
 * received a correct temporary password at the new address and the login
 * answered "Email does not exist in the system". Three PROD rows had drifted
 * apart this way before anyone noticed, one of them a live employee.
 *
 * The unit suite (employees-login-email-sync.spec.ts) pins the service's
 * decisions. This one proves the outcome the user actually experiences: the
 * address in the mail is the address that gets a token, through the real
 * request pipeline and a real database.
 */
describe('employee email edits keep the login working (e2e)', () => {
  let ctx: E2EContext;
  let fx: Fixtures;

  /** Password we force onto the created login row so we can actually sign in. */
  const KNOWN = 'Passw0rd!';
  let hash: string;

  beforeAll(async () => {
    // PROD is 192.168.0.141:8068 and .env has pointed there. Refuse to run
    // anywhere but a dev/test database.
    assertDevDb();
    ctx = await bootE2EApp();
    fx = await setupFixtures(ctx);
    hash = await bcrypt.hash(KNOWN, 10);
  }, 180000);

  afterAll(async () => {
    await fx?.cleanup();
    await ctx?.app.close();
  }, 120000);

  const admin = () => bearer(fx.globalAdmin.token);
  const addr = (tag: string) => `emailsync-${tag}-${fx.runId}@test.local`;

  /** Onboard through the real route, then make its login row signable. */
  const onboard = async (tag: string) => {
    const email = addr(tag);
    const res = await ctx
      .http()
      .post('/employees')
      .set(admin())
      .send({
        fullName: `Email Sync ${tag}`,
        dateOfBirth: '1995-06-15',
        idCard: `NID-EMSYNC-${tag}-${fx.runId}`,
        email,
        departmentId: fx.deptId,
        branchId: fx.branchA,
        position: 'Engineer',
        startDate: '2025-01-06',
        baseSalary: 40000,
      });
    expect(res.status).toBe(201);
    const employeeId = res.body.data.id;

    // The onboarding password is generated and mailed, never returned. Pin a
    // known one on the SAME row so the login assertions below mean something.
    const user = await ctx.prisma.user.findUnique({ where: { employeeId } });
    expect(user).toBeTruthy();
    await ctx.prisma.user.update({
      where: { id: user!.id },
      data: { passwordHash: hash },
    });

    return { employeeId, userId: user!.id, email };
  };

  const login = (email: string, password = KNOWN) =>
    ctx.http().post('/auth/login').send({ email, password });

  const patchEmail = (employeeId: string, email: string) =>
    ctx.http().patch(`/employees/${employeeId}`).set(admin()).send({ email });

  // ───────────────────────────────────────────────────────────────────────────

  it('EMAIL-SYNC-01: onboarding creates a login on the employee address', async () => {
    const { email } = await onboard('base');

    const res = await login(email);
    expect(res.status).toBe(201);
    expect(res.body.data.accessToken).toEqual(expect.any(String));
  });

  it('EMAIL-SYNC-02: editing the email moves the login to the new address', async () => {
    const { employeeId } = await onboard('moved');
    const next = addr('moved2');

    expect((await patchEmail(employeeId, next)).status).toBe(200);

    // Both columns agree in the database...
    const row = await ctx.prisma.user.findUnique({ where: { employeeId } });
    expect(row!.email).toBe(next);

    // ...and the new address is the one that actually signs in. This is the
    // assertion the defect failed: the mail went here and login refused it.
    const ok = await login(next);
    expect(ok.status).toBe(201);
    expect(ok.body.data.accessToken).toEqual(expect.any(String));
  });

  it('EMAIL-SYNC-03: the old address stops working after the edit', async () => {
    const { employeeId, email: before } = await onboard('old');
    const next = addr('old2');
    await patchEmail(employeeId, next);

    const res = await login(before);
    expect(res.status).toBe(401);
    // The refusal text matters as much as the code — it is what the user reads.
    expect(res.body.message).toBe('Email does not exist in the system');
  });

  it('EMAIL-SYNC-04: an address another account holds is refused, and nothing moves', async () => {
    const a = await onboard('clashA');
    const b = await onboard('clashB');

    const res = await patchEmail(a.employeeId, b.email);
    expect(res.status).toBe(409);

    // Refused before any write: A keeps its address on BOTH tables and can
    // still sign in, and B is untouched.
    const empA = await ctx.prisma.employee.findUnique({ where: { id: a.employeeId } });
    const userA = await ctx.prisma.user.findUnique({ where: { id: a.userId } });
    expect(empA!.email).toBe(a.email);
    expect(userA!.email).toBe(a.email);
    expect((await login(a.email)).status).toBe(201);
    expect((await login(b.email)).status).toBe(201);
  });

  it('EMAIL-SYNC-05: Resend Credentials heals a row that drifted before the fix', async () => {
    const { employeeId, userId, email } = await onboard('drift');

    // Reproduce the PROD state directly: the login row left on the old address
    // while the employee record carries the new one.
    const stale = addr('drift-stale');
    await ctx.prisma.user.update({ where: { id: userId }, data: { email: stale } });
    expect((await login(email)).status).toBe(401);

    const res = await ctx
      .http()
      .post(`/employees/${employeeId}/resend-welcome`)
      .set(admin())
      .send({});
    expect(res.status).toBe(201);

    // The address the mail was sent to is now the address that exists.
    const healed = await ctx.prisma.user.findUnique({ where: { id: userId } });
    expect(healed!.email).toBe(email);
    // The password was regenerated by the resend, so only the lookup can be
    // asserted here — "does not exist" must be gone.
    const after = await login(email, 'not-the-mailed-one');
    expect(after.status).toBe(401);
    expect(after.body.message).toBe('Incorrect password');
  });

  it('EMAIL-SYNC-06: Resend refuses to steal an address from another account', async () => {
    const holder = await onboard('stealA');
    const other = await onboard('stealB');

    // Build the collision the resend has to see. `employees.email` is unique
    // too, so the clash can only be staged on the login side: drift `other`'s
    // login off its address first, then park the HOLDER's login on it. Now the
    // address `other`'s employee record carries belongs to somebody else's
    // login, which is exactly what a resend must not overwrite.
    const stale = addr('steal-stale');
    await ctx.prisma.user.update({
      where: { id: other.userId },
      data: { email: stale },
    });
    await ctx.prisma.user.update({
      where: { id: holder.userId },
      data: { email: other.email },
    });

    const res = await ctx
      .http()
      .post(`/employees/${other.employeeId}/resend-welcome`)
      .set(admin())
      .send({});
    expect(res.status).toBe(409);

    // Neither login moved, and no password was handed out against the wrong
    // account: the holder still owns the address, `other` is still parked.
    const holderUser = await ctx.prisma.user.findUnique({ where: { id: holder.userId } });
    const otherUser = await ctx.prisma.user.findUnique({ where: { id: other.userId } });
    expect(holderUser!.email).toBe(other.email);
    expect(otherUser!.email).toBe(stale);
  });
});

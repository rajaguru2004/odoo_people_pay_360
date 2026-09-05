import { EmployeesService, TEMP_PASSWORD_SYMBOLS } from './employees.service';

/**
 * The temporary password is hashed into `users.passwordHash` before it is
 * rendered into anything, so every character it contains has to survive the
 * delivery path byte for byte. When one does not the employee is handed a
 * password that cannot work and the server reports nothing worse than
 * "Incorrect password" — the failure is invisible from both ends.
 *
 * generateTempPassword touches no injected dependency, so the prototype is
 * enough; building the real module here would mean stubbing a dozen services
 * that have nothing to do with the property under test.
 */
describe('EmployeesService temporary password', () => {
  const service = Object.create(EmployeesService.prototype) as EmployeesService;
  const generate = (): string =>
    (service as unknown as { generateTempPassword(): string }).generateTempPassword();

  const RUNS = 2000;

  it('keeps every character class, so password policies still pass', () => {
    for (let i = 0; i < RUNS; i++) {
      const pwd = generate();
      expect(pwd).toHaveLength(10);
      expect(pwd).toMatch(/[A-Z]/);
      expect(pwd).toMatch(/[a-z]/);
      expect(pwd).toMatch(/[0-9]/);
      expect(pwd.split('').some((c) => TEMP_PASSWORD_SYMBOLS.includes(c))).toBe(true);
    }
  });

  it('draws symbols only from the safe pool', () => {
    const allowed = new Set(
      ('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789' +
        TEMP_PASSWORD_SYMBOLS).split(''),
    );
    for (let i = 0; i < RUNS; i++) {
      for (const c of generate()) expect(allowed.has(c)).toBe(true);
    }
  });

  it('holds no renderer markup, which is silently stripped in transit', () => {
    // Pre-fix `*` was in the pool: a renderer that treats it as markup deletes
    // it, so one character vanishes between the hash and the message.
    expect(TEMP_PASSWORD_SYMBOLS).not.toMatch(/[*_~`]/);
  });

  it('shuffles: a character class is not pinned to one position', () => {
    // The old `sort(() => 0.5 - Math.random())` is not a uniform shuffle and
    // left the four guaranteed characters clustered near where they were built.
    const digitAt = new Set<number>();
    for (let i = 0; i < RUNS; i++) {
      const pwd = generate();
      pwd.split('').forEach((c, idx) => {
        if (/[0-9]/.test(c)) digitAt.add(idx);
      });
    }
    expect(digitAt.size).toBe(10);
  });
});

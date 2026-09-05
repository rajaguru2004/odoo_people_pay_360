import { EmployeesService } from './employees.service';
import { escapeWa, kv, WA_SAFE_SYMBOLS } from '../whatsapp/templates/format';

/**
 * The temporary password must come back out of the WhatsApp renderer byte for
 * byte identical, because the hash written to `users.passwordHash` is of the
 * string *before* rendering. When they differ the employee is handed a password
 * that cannot work and the server reports nothing worse than "Incorrect
 * password" — the failure is invisible from both ends.
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

  it('survives the WhatsApp renderer unchanged', () => {
    // Pre-fix this failed on ~20% of passwords: `*` was in the symbol pool, and
    // escapeWa deletes it, so one character vanished between the hash and the
    // message. 2000 runs makes a regression of that size a certainty, not a
    // coin flip.
    const mangled = Array.from({ length: RUNS }, generate).filter(
      (pwd) => escapeWa(pwd) !== pwd,
    );
    expect(mangled).toEqual([]);
  });

  it('reaches the reader intact through the actual credentials line', () => {
    // The renderer as the send path calls it, not a reimplementation of it.
    for (let i = 0; i < RUNS; i++) {
      const pwd = generate();
      expect(kv('Temporary Password', pwd)).toBe(`*Temporary Password:* ${pwd}`);
    }
  });

  it('keeps every character class, so password policies still pass', () => {
    for (let i = 0; i < RUNS; i++) {
      const pwd = generate();
      expect(pwd).toHaveLength(10);
      expect(pwd).toMatch(/[A-Z]/);
      expect(pwd).toMatch(/[a-z]/);
      expect(pwd).toMatch(/[0-9]/);
      expect(pwd.split('').some((c) => WA_SAFE_SYMBOLS.includes(c))).toBe(true);
    }
  });

  it('draws symbols only from the WhatsApp-safe pool', () => {
    const allowed = new Set(
      ('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789' + WA_SAFE_SYMBOLS).split(''),
    );
    for (let i = 0; i < RUNS; i++) {
      for (const c of generate()) expect(allowed.has(c)).toBe(true);
    }
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

  it('WA_SAFE_SYMBOLS itself holds no WhatsApp markup', () => {
    expect(escapeWa(WA_SAFE_SYMBOLS)).toBe(WA_SAFE_SYMBOLS);
  });
});

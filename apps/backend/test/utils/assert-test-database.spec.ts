import { assertTestDatabase } from './assert-test-database';

/**
 * The guard that stands between `npm run test:e2e` and production.
 *
 * This is the one test in the repository whose failure mode is destroyed
 * customer data: the e2e suite creates and deletes branches, users, employees
 * and payroll runs, and it takes its target from `apps/backend/.env` — a file
 * that has pointed at 192.168.0.141 more than once. So both directions matter
 * equally. It must refuse every remote host, and it must not refuse the local
 * database, or the first thing anyone does is delete the guard.
 */

const LOCAL = 'postgresql://postgres:postgres@localhost:8069/ess_e2e';
const PROD = 'postgresql://postgres:postgres@192.168.0.141:8069/myappdb';

describe('assertTestDatabase', () => {
  const ORIGINAL = { ...process.env };
  const CWD = process.cwd();

  afterEach(() => {
    process.env = { ...ORIGINAL };
    process.chdir(CWD);
  });

  /** Both are set every time: an unset one is filled in from the real `.env`. */
  const target = (database: string, direct: string = database) => {
    process.env.DATABASE_URL = database;
    process.env.DIRECT_URL = direct;
  };

  it('allows the local test database', () => {
    target(LOCAL);
    expect(() => assertTestDatabase()).not.toThrow();
  });

  it('allows the loopback address spelled as an IP', () => {
    target('postgresql://postgres:postgres@127.0.0.1:8069/ess_e2e');
    expect(() => assertTestDatabase()).not.toThrow();
  });

  it('allows any database name on the test port, so E2E_DB_NAME keeps working', () => {
    target('postgresql://postgres:postgres@localhost:8069/ess_e2e_b2');
    expect(() => assertTestDatabase()).not.toThrow();
  });

  it('refuses the production host — the incident this exists for', () => {
    target(PROD);
    expect(() => assertTestDatabase()).toThrow(/REFUSING TO RUN/);
  });

  it('refuses the other production host', () => {
    target('postgresql://postgres:postgres@80.225.236.50:8068/myappdb');
    expect(() => assertTestDatabase()).toThrow(/REFUSING TO RUN/);
  });

  it('refuses a remote host even on the test port', () => {
    target('postgresql://postgres:postgres@10.0.0.5:8069/ess_e2e');
    expect(() => assertTestDatabase()).toThrow(/REFUSING TO RUN/);
  });

  it('refuses localhost on a port that is not the test container', () => {
    target('postgresql://postgres:postgres@localhost:5432/ess_e2e');
    expect(() => assertTestDatabase()).toThrow(/REFUSING TO RUN/);
  });

  it('refuses when only DIRECT_URL is remote', () => {
    // Prisma reaches for DIRECT_URL on migrations and some raw paths, so a
    // local DATABASE_URL alone is not proof the run is safe.
    target(LOCAL, PROD);
    expect(() => assertTestDatabase()).toThrow(/DIRECT_URL/);
  });

  it('refuses rather than guesses when no database is configured', () => {
    // Somewhere with no `.env` to fall back on.
    process.chdir('/tmp');
    delete process.env.DATABASE_URL;
    delete process.env.DIRECT_URL;
    expect(() => assertTestDatabase()).toThrow(/is not set/);
  });

  it('never prints the password in its refusal', () => {
    target('postgresql://admin:sup3rs3cret@192.168.0.141:8069/myappdb');
    expect(() => assertTestDatabase()).toThrow(/192\.168\.0\.141/);
    try {
      assertTestDatabase();
    } catch (e) {
      expect((e as Error).message).not.toContain('sup3rs3cret');
    }
  });
});

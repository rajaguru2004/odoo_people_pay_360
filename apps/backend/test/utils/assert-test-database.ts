import * as dotenv from 'dotenv';

/**
 * Refuses to let the e2e suite touch anything but the local test database.
 *
 * The suite CREATES AND DELETES real rows — branches, users, employees, payroll
 * runs — and it resolves its database exactly the way the app does: whatever
 * `apps/backend/.env` says. That file is also the one a developer re-points at
 * a remote host to inspect it, and `apps/backend/.env` has carried
 * `192.168.0.141` (production) more than once.
 *
 * Nothing downstream re-checked. `jest-e2e.json` sets no environment of its
 * own, and `bootE2EApp` boots the real AppModule against whatever
 * `DATABASE_URL` happens to hold — so `npm run test:e2e` with a remote `.env`
 * was a destructive write against production, with no warning and no
 * confirmation. `scripts/e2e-db.sh` already refuses on this same rule, but only
 * for `.env.test`; this closes the path that never goes through that script.
 *
 * The rule matches `scripts/e2e-db.sh` and `.github/workflows/pr.yml`: the
 * database must be on the loopback interface, on the test container's port.
 * There is deliberately NO opt-out — a flag to disable this would be the first
 * thing reached for at the exact moment it matters.
 *
 * Note this does NOT protect a local dev database on the same port from being
 * used as the e2e target (`ess_e2e` vs `myappdb` on localhost:8069). Naming the
 * allowed database here would break `E2E_DB_NAME`, which the browser runner
 * supports on purpose. Production is what this guard is for.
 */

/** Loopback only — a remote host can never be the test database. */
const ALLOWED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);
/** The port docker-compose.test.yml publishes for the test Postgres. */
const REQUIRED_PORT = '8069';

/** Connection URL with the password removed, safe to print in an error. */
function redact(raw: string): string {
  try {
    const u = new URL(raw);
    const user = u.username ? `${u.username}@` : '';
    return `${u.protocol}//${user}${u.host}${u.pathname}`;
  } catch {
    return '(unparseable connection string)';
  }
}

function check(key: string, raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `E2E DATABASE GUARD: ${key} is not a valid connection URL. ` +
        `Expected postgresql://…@localhost:${REQUIRED_PORT}/<test-db>.`,
    );
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!ALLOWED_HOSTNAMES.has(host) || url.port !== REQUIRED_PORT) {
    throw new Error(
      [
        '',
        '  ██ E2E DATABASE GUARD — REFUSING TO RUN ██',
        '',
        `  ${key} points at:  ${redact(raw)}`,
        `  The e2e suite may only run against localhost:${REQUIRED_PORT}.`,
        '',
        '  This suite creates and deletes real rows. Running it against a',
        '  remote database — 192.168.0.141 is PRODUCTION — would destroy data.',
        '',
        '  Fix: point apps/backend/.env at the local database, or export a',
        '  safe URL for this command only:',
        '',
        `    DATABASE_URL="postgresql://postgres:postgres@localhost:${REQUIRED_PORT}/ess_e2e" \\`,
        `    DIRECT_URL="postgresql://postgres:postgres@localhost:${REQUIRED_PORT}/ess_e2e" \\`,
        '    npm run test:e2e',
        '',
      ].join('\n'),
    );
  }
}

/**
 * Throws unless every configured database URL is the local test database.
 *
 * Loads `.env` first, with dotenv's normal "never overwrite what is already
 * set" behaviour — the same precedence `@nestjs/config` applies — so this reads
 * exactly what the app under test will read, whether the value came from the
 * file or from the shell.
 */
export function assertTestDatabase(): void {
  dotenv.config();

  const primary = process.env.DATABASE_URL;
  if (!primary) {
    throw new Error(
      'E2E DATABASE GUARD: DATABASE_URL is not set, so the target database is ' +
        'unknown. Refusing to run rather than guess.',
    );
  }

  check('DATABASE_URL', primary);
  // Prisma uses DIRECT_URL for migrations and some raw paths; a mismatched one
  // is the same hazard by another name.
  if (process.env.DIRECT_URL) check('DIRECT_URL', process.env.DIRECT_URL);
}

/** Jest `globalSetup` entry — runs once, before any e2e spec is loaded. */
export default async function globalSetup(): Promise<void> {
  assertTestDatabase();
}

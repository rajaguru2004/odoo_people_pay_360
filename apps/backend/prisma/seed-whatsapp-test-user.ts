/**
 * Create (or refresh) the WhatsApp test user and link a handset to it.
 *
 * Exists so the inbound channel can be exercised end to end without going
 * through the three-leg enrolment by hand every time the dev database is reset.
 * It writes the identity as ACTIVE directly, which is precisely what the real
 * flow refuses to do — hence the guard: it will not run against a database that
 * looks like production.
 *
 *   npm run seed:whatsapp-test -- --phone +919952982836 [--pin 482915]
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import parsePhoneNumberFromString from 'libphonenumber-js';

const prisma = new PrismaClient();

const arg = (name: string, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const PHONE = arg('phone', '+919952982836');
const PIN = arg('pin', '482915');
const EMAIL = arg('email', 'whatsapp.tester@sample.hrms.local');
const CODE = arg('code', 'WA-TEST-01');

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed a test identity in production.');
  }

  const parsed = parsePhoneNumberFromString(PHONE);
  if (!parsed?.isValid()) throw new Error(`'${PHONE}' is not a valid phone number.`);
  const phoneE164 = parsed.number;

  console.log(`📱 WhatsApp test user → ${phoneE164}`);

  // A real branch and department, so branch scoping behaves like production
  // rather than silently passing because everything is null.
  //
  // NOT simply the oldest branch: a dev database accumulates leftovers from
  // crashed e2e runs (E2E-A-…, DW-BR-…, SUP-BR-…) which are older than the real
  // seed data and carry their own geofence coordinates. Landing the test user
  // in one of those means every attendance test is silently measured against
  // some other city. Prefer an explicit --branch, then Head Office, then any
  // branch that does not look like test debris.
  const wanted = arg('branch', '');
  const branches = await prisma.branch.findMany({ orderBy: { createdAt: 'asc' } });
  const isDebris = (code: string) => /^(E2E|DW-BR|SUP-BR|TEST)/i.test(code);

  const branch =
    (wanted && branches.find((b) => b.code === wanted)) ||
    branches.find((b) => b.code === 'HO') ||
    branches.find((b) => !isDebris(b.code)) ||
    branches[0];

  const department = await prisma.department.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!branch || !department) {
    throw new Error('Seed a branch and a department first (npm run prisma:seed).');
  }
  if (wanted && branch.code !== wanted) {
    throw new Error(`No branch with code '${wanted}'. Found: ${branches.map((b) => b.code).join(', ')}`);
  }
  if (isDebris(branch.code)) {
    console.warn(
      `⚠️  Only test-debris branches exist; using ${branch.code}. Run the real seed for a clean branch.`,
    );
  }

  const employee = await prisma.employee.upsert({
    where: { email: EMAIL },
    update: { fullName: 'WhatsApp Tester', phone: phoneE164, status: 'ACTIVE' },
    create: {
      employeeCode: CODE,
      fullName: 'WhatsApp Tester',
      email: EMAIL,
      phone: phoneE164,
      position: 'QA Engineer',
      departmentId: department.id,
      branchId: branch.id,
      baseSalary: 40000,
      dateOfBirth: new Date(Date.UTC(1995, 5, 15)),
      idCard: `ID-${CODE}`,
      startDate: new Date(Date.UTC(2026, 0, 1)),
      status: 'ACTIVE',
    },
  });

  const user = await prisma.user.upsert({
    where: { email: EMAIL },
    update: { employeeId: employee.id, isActive: true, role: 'EMPLOYEE' },
    create: {
      email: EMAIL,
      passwordHash: await bcrypt.hash('Password123!', 10),
      role: 'EMPLOYEE',
      employeeId: employee.id,
      isActive: true,
      isEmailVerified: true,
    },
  });

  // Nobody else may hold this number: phone_e164 is unique, and a stale row
  // from an earlier run would otherwise make the upsert fail confusingly.
  await prisma.whatsAppIdentity.deleteMany({
    where: { phoneE164, NOT: { userId: user.id } },
  });

  const identityData = {
    userId: user.id,
    employeeId: employee.id,
    branchId: branch.id,
    phoneE164,
    source: 'ADMIN',
    status: 'ACTIVE',
    optedIn: true,
    optedInAt: new Date(),
    optedOutAt: null,
    verified: true,
    verifiedAt: new Date(),
    handsetOptInAt: new Date(),
    failureCount: 0,
    lastError: null,
    failedPinCount: 0,
    lockedUntil: null,
    revokedAt: null,
    pinHash: await bcrypt.hash(PIN, 10),
    pinSetAt: new Date(),
  };

  const existing = await prisma.whatsAppIdentity.findFirst({ where: { userId: user.id } });
  const identity = existing
    ? await prisma.whatsAppIdentity.update({ where: { id: existing.id }, data: identityData })
    : await prisma.whatsAppIdentity.create({ data: identityData });

  // A clean slate: a leftover half-finished flow would make the first test
  // message look like an answer to a forgotten question.
  await prisma.whatsAppSession.deleteMany({
    where: { remoteJid: `${phoneE164.replace('+', '')}@s.whatsapp.net` },
  });

  console.log(`   employee  : ${employee.employeeCode} ${employee.fullName}`);
  console.log(`   branch    : ${branch.code}`);
  console.log(`   login     : ${EMAIL} / Password123!`);
  console.log(`   identity  : ${identity.status}, PIN ${PIN}`);
  console.log('\n✅ Ready. Message the business number from that handset and reply MENU.');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e.message ?? e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

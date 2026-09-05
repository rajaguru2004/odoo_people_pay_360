/**
 * Top up an already-seeded demo database with the rows the module hubs read.
 *
 * The full sample seed goes through Nest (`prisma:seed:sample`) because it
 * shares `SampleDataService` with the UI-triggered seed. This runner does not:
 * it talks to Prisma directly, so it works on a machine where the Nest CLI
 * context cannot boot, and it is the right tool anyway when the sample data is
 * already present and only the dashboard aggregates are missing.
 *
 * Idempotent: it clears the rows it owns before writing them.
 *
 * Run:  npm run prisma:seed:demo-fill   (from apps/backend)
 */

import { PrismaClient } from '@prisma/client';
import { DEMO_AUDIT_MARKER, seedDemoFill } from '../src/sample-data/sample-data.demo-fill';
import type { ExtrasContext } from '../src/sample-data/sample-data.extras';

const prisma = new PrismaClient();
const SAMPLE_EMAIL = '@sample.hrms.local';

/** Deterministic, so a re-run produces the same demo. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Only what this script writes — never the base sample data. */
async function clearOwnRows(): Promise<void> {
  const ofEmp = { employee: { email: { endsWith: SAMPLE_EMAIL } } };
  // WPS holds payroll_id with onDelete: Restrict, so it leads.
  await prisma.wpsFile.deleteMany({ where: { payroll: { batch: { name: { startsWith: 'SMP' } } } } });
  await prisma.gratuityAccrual.deleteMany({ where: ofEmp });
  await prisma.finalSettlement.deleteMany({ where: ofEmp });
  await prisma.loanSchedule.deleteMany({ where: { request: ofEmp } });
  // The extra open run this script creates, identified by its note.
  await prisma.payroll.deleteMany({
    where: { batch: { name: { startsWith: 'SMP' } }, notes: { startsWith: 'Left open' } },
  });
  await prisma.auditLog.deleteMany({ where: { userAgent: DEMO_AUDIT_MARKER } });
}

async function main(): Promise<void> {
  console.log('🌱 Filling module-dashboard data for the demo…');
  await clearOwnRows();

  const employees = await prisma.employee.findMany({
    where: { email: { endsWith: SAMPLE_EMAIL } },
    select: {
      id: true, email: true, fullName: true, baseSalary: true, startDate: true,
      branchId: true, departmentId: true,
    },
    orderBy: { employeeCode: 'asc' },
  });
  if (!employees.length) {
    throw new Error(`No sample employees found. Run the sample seed first.`);
  }

  const branches = await prisma.branch.findMany({
    where: { code: { startsWith: 'SMP' } },
    select: { id: true },
    orderBy: { code: 'asc' },
  });
  const branchIds = branches.map((b) => b.id);
  const deptIds = (
    await prisma.department.findMany({ select: { id: true }, orderBy: { code: 'asc' } })
  ).map((d) => d.id);

  const hrUser =
    (await prisma.user.findFirst({ where: { email: { endsWith: SAMPLE_EMAIL }, role: 'HR_MANAGER' }, select: { id: true } })) ??
    (await prisma.user.findFirst({ where: { role: 'ADMIN' }, select: { id: true } }));
  if (!hrUser) throw new Error('No HR or admin user to attribute seeded rows to.');

  const now = new Date();
  const prevD = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));

  const ctx: ExtrasContext = {
    prisma,
    employees: employees.map((e, index) => ({
      id: e.id,
      index,
      branchIndex: Math.max(0, branchIds.indexOf(e.branchId ?? '')),
      deptIndex: Math.max(0, deptIds.indexOf(e.departmentId)),
      email: e.email,
      fullName: e.fullName,
      baseSalary: Number(e.baseSalary),
      startDate: e.startDate,
    })),
    deptIds,
    branchIds: branchIds.length ? branchIds : [employees[0].branchId!].filter(Boolean),
    userIdByEmpIdx: {},
    hrUserId: hrUser.id,    months: [
      { year: prevD.getUTCFullYear(), month: prevD.getUTCMonth() + 1 },
      { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 },
    ],
    rng: mulberry32(20260608),
    say: (m) => console.log(`  • ${m}`),
    info: (m) => console.log(`    ${m}`),
  };

  await seedDemoFill(ctx);
  console.log('✅ Module dashboards filled.');
}

main()
  .catch((e) => {
    console.error('❌ Demo fill failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

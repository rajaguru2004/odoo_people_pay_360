/**
 * Idempotent bootstrap seed.
 *
 * Runs on every container start (see docker-entrypoint.sh) and on demand with
 * `npm run db:seed`, so every statement here has to be safe to repeat. That
 * means upserts keyed on a natural unique column — never `create` — and it
 * means the admin's `update` branch deliberately does NOT touch passwordHash:
 * re-running the seed must not silently reset a password somebody changed in
 * the app.
 */
import { PrismaClient, SalaryComponentType, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

const SALARY_COMPONENTS = [
  { code: 'BASIC', name: 'Basic Salary', type: SalaryComponentType.EARNING, isGratuityBase: true, sequence: 10 },
  { code: 'HRA', name: 'Housing Allowance', type: SalaryComponentType.EARNING, isGratuityBase: false, sequence: 20 },
  { code: 'TRANSPORT', name: 'Transport Allowance', type: SalaryComponentType.EARNING, isGratuityBase: false, sequence: 30 },
  { code: 'OTHER_ALLOW', name: 'Other Allowances', type: SalaryComponentType.EARNING, isGratuityBase: false, sequence: 40 },
  { code: 'SOCIAL_SEC_EE', name: 'Social Security (Employee)', type: SalaryComponentType.DEDUCTION, isGratuityBase: false, sequence: 110 },
  { code: 'LOAN_REPAY', name: 'Loan Repayment', type: SalaryComponentType.DEDUCTION, isGratuityBase: false, sequence: 120 },
  { code: 'SOCIAL_SEC_ER', name: 'Social Security (Employer)', type: SalaryComponentType.EMPLOYER_CONTRIBUTION, isGratuityBase: false, sequence: 210 },
];

async function seedCompany() {
  const existing = await prisma.company.findFirst();
  const company =
    existing ??
    (await prisma.company.create({
      data: { name: 'People Pay 360', legalName: 'People Pay 360 LLC', timezone: 'Asia/Muscat', currency: 'OMR' },
    }));

  const branch = await prisma.branch.upsert({
    where: { code: 'HQ' },
    update: { name: 'Head Office', companyId: company.id },
    create: { code: 'HQ', name: 'Head Office', companyId: company.id },
  });

  await prisma.department.upsert({
    where: { code: 'ADMIN' },
    update: { name: 'Administration', branchId: branch.id },
    create: { code: 'ADMIN', name: 'Administration', branchId: branch.id },
  });

  console.log(`  ✔ company "${company.name}" + HQ branch + Administration department`);
  return { company, branch };
}

async function seedSalaryComponents() {
  for (const c of SALARY_COMPONENTS) {
    await prisma.salaryComponent.upsert({
      where: { code: c.code },
      update: { name: c.name, type: c.type, isGratuityBase: c.isGratuityBase, sequence: c.sequence },
      create: c,
    });
  }
  console.log(`  ✔ ${SALARY_COMPONENTS.length} salary components`);
}

async function seedAdmin() {
  const email = (process.env.SEED_ADMIN_EMAIL || 'admin@peoplepay360.com').toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD || 'Admin@123';

  const user = await prisma.user.upsert({
    where: { email },
    // NOT passwordHash. See the note at the top of this file.
    update: { role: UserRole.ADMIN, isActive: true },
    create: { email, passwordHash: await bcrypt.hash(password, 12), role: UserRole.ADMIN },
  });

  console.log(`  ✔ admin ${user.email}`);
}

async function main() {
  console.log('🌱 Seeding People Pay 360...');
  await seedCompany();
  await seedSalaryComponents();
  await seedAdmin();
  console.log('✅ Seed complete.');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());

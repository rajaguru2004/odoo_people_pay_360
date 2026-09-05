/**
 * CLI wrapper for the Muscat (Oman) payroll demo completion.
 *
 * The logic lives in `src/sample-data/sample-data.muscat-payroll.ts` — the same
 * module the Settings → Sample Data seed runs — so the button and the command
 * line cannot drift apart. This script exists for the case the button cannot
 * cover: repairing a branch whose employees were created by a DIFFERENT seed
 * (the `NX-` logins), which the sample seeder does not own and will not touch.
 *
 * Run (from apps/backend), against a demo database — never PROD:
 *   npm run prisma:seed:muscat-payroll
 *   DRY_RUN=1 npm run prisma:seed:muscat-payroll   # rehearse, then roll back
 */

import { PrismaClient } from '@prisma/client';
import { seedMuscatPayrollDemo } from '../src/sample-data/sample-data.muscat-payroll';

const prisma = new PrismaClient();
const DRY_RUN = process.env.DRY_RUN === '1';
const BRANCH_CODE = process.env.BRANCH_CODE ?? 'SMP-MCT';

async function main(db: PrismaClient) {
  console.log(`🌱 Muscat payroll demo — branch ${BRANCH_CODE}\n`);
  const counts = await seedMuscatPayrollDemo(db, {
    branchCode: BRANCH_CODE,
    year: Number(process.env.SEED_YEAR) || new Date().getUTCFullYear(),
    say: (m) => console.log(`  • ${m}`),
    info: (m) => console.log(`    ${m}`),
  });
  console.log('\n✅ Done.');
  console.table(counts);
  if (DRY_RUN) console.log('   DRY_RUN=1 — everything above was rolled back.');
}

(async () => {
  if (DRY_RUN) {
    await prisma
      .$transaction(
        async (tx) => {
          await main(tx as unknown as PrismaClient);
          throw new Error('__ROLLBACK__');
        },
        // The seed walks every employee in the branch one by one; the 5s default
        // expires long before it finishes and the rollback would be reported as
        // a timeout rather than the rehearsal it is.
        { timeout: 120_000, maxWait: 30_000 },
      )
      .catch((e: any) => {
        if (e?.message !== '__ROLLBACK__') throw e;
      });
  } else {
    await main(prisma);
  }
})()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

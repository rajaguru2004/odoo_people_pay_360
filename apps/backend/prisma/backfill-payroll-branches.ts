/**
 * One-off, idempotent backfill for per-branch payroll (migration
 * 20260711000000_add_payroll_branch adds Payroll.branchId / PayrollBatch.branchId).
 *
 * Derives each run's/batch's branch from its constituent employees:
 *   - PayrollBatch.branchId  <- the single distinct branch of its members' employees.
 *   - Payroll.branchId       <- its batch's branch, else the single distinct branch
 *                               of its items' employees.
 * A batch/run whose members span MULTIPLE branches (legacy company-wide run) is
 * left NULL on purpose — null = company-wide, which the branch scope treats as
 * visible only to global/all-branches callers.
 *
 * Only fills rows where branchId IS NULL, so it is safe to run repeatedly.
 * Run: npx ts-node --transpile-only prisma/backfill-payroll-branches.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** The single distinct non-null value in a list, or null if none/mixed. */
function soleValue(ids: (string | null)[]): string | null {
  const distinct = [...new Set(ids.filter((id): id is string => !!id))];
  return distinct.length === 1 ? distinct[0] : null;
}

async function main() {
  console.log('💰 Per-branch payroll backfill starting...');

  // 1. Batches: branch from members' employees ------------------------------
  const batches = await prisma.payrollBatch.findMany({
    where: { branchId: null },
    include: { members: { include: { employee: { select: { branchId: true } } } } },
  });
  let batchUpdated = 0;
  const batchBranch = new Map<string, string | null>();
  for (const batch of batches) {
    const branchId = soleValue(batch.members.map((m) => m.employee.branchId));
    batchBranch.set(batch.id, branchId);
    if (branchId) {
      await prisma.payrollBatch.update({ where: { id: batch.id }, data: { branchId } });
      batchUpdated++;
    }
  }
  console.log(`   batches: ${batchUpdated}/${batches.length} stamped (rest span multiple branches → left company-wide)`);

  // 2. Payrolls: prefer the batch's branch, else items' employees -----------
  const payrolls = await prisma.payroll.findMany({
    where: { branchId: null },
    include: {
      batch: { select: { branchId: true } },
      items: { include: { employee: { select: { branchId: true } } } },
    },
  });
  let payrollUpdated = 0;
  for (const payroll of payrolls) {
    const fromBatch =
      payroll.batch?.branchId ?? (payroll.batchId ? batchBranch.get(payroll.batchId) ?? null : null);
    const branchId = fromBatch ?? soleValue(payroll.items.map((i) => i.employee.branchId));
    if (branchId) {
      await prisma.payroll.update({ where: { id: payroll.id }, data: { branchId } });
      payrollUpdated++;
    }
  }
  console.log(`   payrolls: ${payrollUpdated}/${payrolls.length} stamped (rest span multiple branches → left company-wide)`);

  console.log('✅ Per-branch payroll backfill complete.');
}

main()
  .catch((e) => {
    console.error('❌ Backfill failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

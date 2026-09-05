import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * Snapshot / restore for the shared `loan_*` and `advance_loan_*` settings.
 *
 * These suites run against DEMO databases. A spec that flips
 * `loan_module_v2_enabled` and does not put it back silently changes how the
 * demo environment recovers money — so every suite that touches loan config
 * must snapshot in `beforeAll` and restore in `afterAll`. Same discipline as
 * `approval-switch.ts`.
 *
 * `null` in the snapshot means "the key did not exist", and restore deletes it
 * again rather than writing a default that was never there.
 */
export type LoanConfigSnapshot = Record<string, string | null>;

export async function readLoanConfig(
  prisma: PrismaService,
  keys: string[],
): Promise<LoanConfigSnapshot> {
  const rows = await prisma.systemSetting.findMany({
    where: { key: { in: keys } },
    select: { key: true, value: true },
  });
  const found = new Map(rows.map((r) => [r.key, r.value]));
  const snap: LoanConfigSnapshot = {};
  for (const k of keys) snap[k] = found.get(k) ?? null;
  return snap;
}

export async function writeLoanConfig(
  prisma: PrismaService,
  values: Record<string, string>,
): Promise<void> {
  for (const [key, value] of Object.entries(values)) {
    await prisma.systemSetting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }
}

export async function restoreLoanConfig(
  prisma: PrismaService,
  snap: LoanConfigSnapshot,
): Promise<void> {
  for (const [key, value] of Object.entries(snap)) {
    if (value === null) {
      await prisma.systemSetting.deleteMany({ where: { key } });
    } else {
      await prisma.systemSetting.upsert({
        where: { key },
        create: { key, value },
        update: { value },
      });
    }
  }
}

/**
 * Delete a loan and everything hanging off it, children first.
 *
 * `advance_loan_requests.employee_id` is onDelete: RESTRICT, so a suite that
 * creates loans and then deletes its employees MUST call this or it leaves
 * fixtures behind in the shared database.
 */
export async function purgeLoans(
  prisma: PrismaService,
  requestIds: string[],
): Promise<void> {
  if (requestIds.length === 0) return;
  const where = { requestId: { in: requestIds } };
  await prisma.advanceLoanNotificationLog.deleteMany({ where });
  await prisma.loanTransaction.deleteMany({ where });
  await prisma.loanRateChange.deleteMany({ where });
  await prisma.advanceLoanDeduction.deleteMany({ where });
  await prisma.advanceLoanAttachment.deleteMany({ where });
  await prisma.loanSchedule.deleteMany({ where });
  await prisma.advanceLoanRequest.deleteMany({
    where: { id: { in: requestIds } },
  });
}

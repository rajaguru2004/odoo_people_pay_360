/**
 * DEMO/DEV ONLY — wipe every payroll and leave one clean, properly-locked run.
 *
 * Deleting payrolls is not just a `deleteMany`: locking a payroll moves real money
 * state that a plain delete would strand.
 *
 *   • wps_files.payroll_id is onDelete: Restrict, so files must go first or the
 *     delete fails outright.
 *   • Reimbursement.payrollItemId is SetNull — the row survives, keeping whatever
 *     status it had. A reimbursement that lockPayroll flipped to PAID would be left
 *     marked paid with nothing backing it, AND excluded from future runs (the engine
 *     only picks up APPROVED, unlinked ones). So PAID ones are reverted to APPROVED.
 *   • AdvanceLoanDeduction.payrollItemId is onDelete: Cascade, so the rows vanish —
 *     but lockPayroll incremented AdvanceLoanRequest.amountRepaid, which would stay
 *     inflated and under-collect the loan. PAID deductions are decremented first.
 *
 * Refuses to run against a database whose URL does not look like a demo/local host,
 * because "delete all payrolls" is not something to fat-finger at production.
 *
 *   node scripts/reset-payrolls-for-wps-demo.js            # show what it would do
 *   node scripts/reset-payrolls-for-wps-demo.js --confirm  # actually do it
 */
const { PrismaClient } = require('@prisma/client');

const PROD_HOST_HINTS = ['192.168.0.141:8068']; // documented production
const confirmed = process.argv.includes('--confirm');

(async () => {
  const url = process.env.DATABASE_URL || '';
  const host = (url.match(/@([^/]+)\//) || [])[1] || 'unknown';

  if (PROD_HOST_HINTS.some((h) => url.includes(h))) {
    console.error(`REFUSING: ${host} is the documented production target.`);
    process.exit(1);
  }
  console.log(`target: ${host}`);
  console.log(confirmed ? 'mode:   DESTRUCTIVE (--confirm given)\n' : 'mode:   dry run\n');

  const p = new PrismaClient();
  try {
    const payrolls = await p.payroll.findMany({
      include: { branch: { select: { code: true } }, _count: { select: { items: true } } },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
    });

    console.log(`payrolls to delete: ${payrolls.length}`);
    for (const x of payrolls) {
      console.log(
        `  ${String(x.month).padStart(2, '0')}/${x.year} v${x.version} ${x.status.padEnd(17)} ` +
          `${(x.branch?.code ?? 'NULL-branch').padEnd(12)} items=${x._count.items}`,
      );
    }

    const ids = payrolls.map((x) => x.id);
    if (ids.length === 0) {
      console.log('\nnothing to do.');
      return;
    }

    const wpsFiles = await p.wpsFile.count({ where: { payrollId: { in: ids } } });
    const wpsRows = await p.wpsFileRow.count({ where: { wpsFile: { payrollId: { in: ids } } } });
    const paidReimb = await p.reimbursement.findMany({
      where: { payrollItem: { payrollId: { in: ids } }, status: 'PAID' },
      select: { id: true },
    });
    const linkedReimb = await p.reimbursement.count({
      where: { payrollItem: { payrollId: { in: ids } } },
    });
    const paidDeductions = await p.advanceLoanDeduction.findMany({
      where: { payrollItem: { payrollId: { in: ids } }, status: 'PAID' },
      select: { requestId: true, amount: true },
    });
    const allDeductions = await p.advanceLoanDeduction.count({
      where: { payrollItem: { payrollId: { in: ids } } },
    });

    console.log('\nknock-on effects:');
    console.log(`  wps_file_rows deleted          : ${wpsRows}`);
    console.log(`  wps_files deleted              : ${wpsFiles}`);
    console.log(`  reimbursements unlinked        : ${linkedReimb}`);
    console.log(`    of those reverted PAID->APPROVED so they are payable again: ${paidReimb.length}`);
    console.log(`  advance/loan deductions removed: ${allDeductions}`);
    console.log(`    amountRepaid decremented for PAID ones: ${paidDeductions.length}`);

    if (!confirmed) {
      console.log('\ndry run — nothing changed. Re-run with --confirm.');
      return;
    }

    // 1. Wage files first: Restrict on payroll_id blocks everything else.
    await p.wpsFileRow.deleteMany({ where: { wpsFile: { payrollId: { in: ids } } } });
    await p.wpsFile.deleteMany({ where: { payrollId: { in: ids } } });

    // 2. Give back the money state locking had consumed.
    const byRequest = new Map();
    for (const d of paidDeductions) {
      byRequest.set(d.requestId, (byRequest.get(d.requestId) ?? 0) + Number(d.amount));
    }
    for (const [requestId, amount] of byRequest) {
      await p.advanceLoanRequest.update({
        where: { id: requestId },
        data: { amountRepaid: { decrement: amount } },
      });
    }
    if (paidReimb.length > 0) {
      await p.reimbursement.updateMany({
        where: { id: { in: paidReimb.map((r) => r.id) } },
        data: { status: 'APPROVED', paidAt: null },
      });
    }
    // Unlink explicitly rather than relying on SetNull, so a reimbursement is
    // immediately eligible for the next run.
    await p.reimbursement.updateMany({
      where: { payrollItem: { payrollId: { in: ids } } },
      data: { payrollItemId: null },
    });

    // 3. Items (cascades the loan-deduction rows), then the payrolls.
    const items = await p.payrollItem.deleteMany({ where: { payrollId: { in: ids } } });
    const runs = await p.payroll.deleteMany({ where: { id: { in: ids } } });

    console.log(`\ndeleted ${runs.count} payroll(s) and ${items.count} item(s).`);
    console.log('remaining payrolls:', await p.payroll.count());
    console.log('remaining wps_files:', await p.wpsFile.count());
  } finally {
    await p.$disconnect();
  }
})();

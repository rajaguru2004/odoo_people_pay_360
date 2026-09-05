/**
 * Review report for the pay-basis convergence in migration
 * 20260729120000_add_library_item_pay_basis.
 *
 * That migration made the EMPLOYMENT_TYPE library item the source of truth for
 * an employee's pay basis, which means some employees flipped from MONTHLY to
 * DAILY. A flip re-interprets `base_salary`: 50000 stops meaning "50000 a
 * month" and starts meaning "50000 for each day worked". Where the stored
 * number was really a monthly salary, that is a ~26x overpayment waiting for
 * the next payroll run.
 *
 * This script lists every employee the migration moved and flags the ones whose
 * rate does not look like a day rate. Run it right after applying the
 * migration, and again after fixing anything it flags:
 *
 *   npm run prisma:report:daily-wage
 *
 * Read-only — it never writes.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * A day rate above this is almost certainly a monthly figure that was never
 * re-entered. Deliberately currency-agnostic and deliberately generous: this
 * flags for human review, it does not decide anything.
 */
const SUSPICIOUS_DAY_RATE = 5000;

async function main() {
  // The migration writes one audit row per flip, so the history IS the report.
  const flips = await prisma.employeeHistory.findMany({
    where: { field: 'salaryType' },
    orderBy: { changedAt: 'desc' },
    select: {
      employeeId: true,
      oldValue: true,
      newValue: true,
      changedAt: true,
    },
  });

  if (flips.length === 0) {
    console.log('✅ No pay-basis changes recorded — nothing to review.');
    return;
  }

  // Keep only the most recent flip per employee: an employee edited by hand
  // after the migration should be judged on where they ended up, not on every
  // intermediate state.
  const latest = new Map<string, (typeof flips)[number]>();
  for (const f of flips) if (!latest.has(f.employeeId)) latest.set(f.employeeId, f);

  const employees = await prisma.employee.findMany({
    where: { id: { in: [...latest.keys()] } },
    select: {
      id: true,
      employeeCode: true,
      fullName: true,
      employmentType: true,
      salaryType: true,
      baseSalary: true,
      status: true,
    },
    orderBy: { employeeCode: 'asc' },
  });

  const rows = employees
    .map((e) => {
      const flip = latest.get(e.id)!;
      const rate = Number(e.baseSalary);
      return {
        ...e,
        rate,
        from: flip.oldValue ?? '—',
        to: flip.newValue ?? '—',
        // Only a MONTHLY -> DAILY move can turn a monthly salary into a day
        // rate. The reverse direction is harmless: a day rate read as a monthly
        // salary underpays visibly rather than overpaying silently.
        suspicious:
          e.salaryType === 'DAILY' && rate > SUSPICIOUS_DAY_RATE,
      };
    })
    // Stale flips whose employee has since been changed back are noise.
    .filter((r) => r.from !== r.to);

  console.log(`\n📋 Pay-basis changes recorded: ${rows.length}\n`);
  for (const r of rows) {
    const marker = r.suspicious ? '  ** REVIEW **' : '';
    console.log(
      `  ${(r.employeeCode ?? '—').padEnd(10)} ${(r.fullName ?? '').padEnd(28)} ` +
        `${(r.employmentType ?? '—').padEnd(16)} ${r.from} -> ${r.to}  ` +
        `rate ${r.rate}  [${r.status}]${marker}`,
    );
  }

  const flagged = rows.filter((r) => r.suspicious);
  if (flagged.length > 0) {
    console.log(
      `\n⚠️  ${flagged.length} employee(s) now on DAILY carry a base salary above ` +
        `${SUSPICIOUS_DAY_RATE}, which reads like a monthly figure.\n` +
        `    Their base salary must be re-entered as a PER-DAY rate before the ` +
        `next payroll run, or they will be paid that amount for every day worked.`,
    );
    process.exitCode = 1;
  } else {
    console.log('\n✅ Every converged employee carries a plausible day rate.');
  }
}

main()
  .catch((e) => {
    console.error('❌ Report failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

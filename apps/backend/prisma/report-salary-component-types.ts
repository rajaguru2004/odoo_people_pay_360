/**
 * Review report for the salary-component type decoupling.
 *
 * `salary_components.component_type` used to be validated against a nine-value
 * enum, and the frontend mapped every unrecognised library label onto `OTHER`.
 * An admin who added "HRA" and "DA" got two rows both stored and displayed as
 * "Other", which is why a real salary breakup could not be configured at all.
 * The set is open now: any uppercase slug is accepted, and `toComponentCode()`
 * derives it from the library label.
 *
 * The consequence for an existing database is a SPLIT, not a break:
 *
 *   rows written BEFORE the change under label "Housing Allowance" -> OTHER
 *   rows written AFTER  the change under label "Housing Allowance" -> HOUSING
 *
 * Payroll totals are unaffected — only `BASIC` and `PAYROLL_CONFIG` mean
 * anything to the engine and everything else sums as an allowance either way —
 * but any report that GROUPS BY component_type will show the same concept in
 * two buckets.
 *
 * There is deliberately no automatic backfill. The original label is not
 * recoverable from a stored `OTHER`, so any remapping would be a guess written
 * to production payroll data. This script shows you the shape of the problem so
 * a human who knows what those rows meant can write the UPDATE.
 *
 *   DATABASE_URL="postgresql://…" npm run prisma:report:salary-component-types
 *
 * DATABASE_URL is required explicitly, matching the other prisma/report-*
 * scripts and scripts/apply-migration.sh: naming the target is the point, since
 * apps/backend/.env has pointed at production hosts before.
 *
 * Read-only — it never writes.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** Codes the payroll engine actually reads. Everything else is an allowance. */
const ENGINE_CODES = new Set(['BASIC', 'PAYROLL_CONFIG']);

async function main() {
  const rows = await prisma.salaryComponent.groupBy({
    by: ['componentType'],
    _count: { _all: true },
    orderBy: { _count: { componentType: 'desc' } },
  });

  if (rows.length === 0) {
    console.log('No salary components. Nothing to report.');
    return;
  }

  console.log('\n─ component_type distribution ────────────────────────────');
  for (const r of rows) {
    const engine = ENGINE_CODES.has(r.componentType) ? '  (payroll engine)' : '';
    console.log(
      `  ${r.componentType.padEnd(24)} ${String(r._count._all).padStart(6)}${engine}`,
    );
  }

  const other = rows.find((r) => r.componentType === 'OTHER');
  if (!other) {
    console.log(
      '\n✅ No OTHER rows. Nothing was collapsed, so there is nothing to remap.\n',
    );
    return;
  }

  // The notes are the only surviving hint of what an OTHER row was meant to be.
  const samples = await prisma.salaryComponent.findMany({
    where: { componentType: 'OTHER' },
    select: {
      id: true,
      note: true,
      amount: true,
      employee: { select: { employeeCode: true, fullName: true } },
    },
    take: 20,
    orderBy: { createdAt: 'asc' },
  });

  const affected = await prisma.salaryComponent.findMany({
    where: { componentType: 'OTHER' },
    select: { employeeId: true },
    distinct: ['employeeId'],
  });

  console.log(
    `\n⚠️  ${other._count._all} row(s) are stored as OTHER, across ${affected.length} employee(s).`,
  );
  console.log(
    '   Some may be genuinely "Other"; the rest are pre-change rows whose real\n' +
      '   label was collapsed. Only someone who knows this data can tell them apart.\n',
  );
  console.log('─ oldest OTHER rows, with whatever note survives ─────────');
  for (const s of samples) {
    console.log(
      `  ${(s.employee?.employeeCode ?? '—').padEnd(12)} ` +
        `${(s.employee?.fullName ?? '').slice(0, 24).padEnd(26)} ` +
        `${String(s.amount).padStart(12)}  ${s.note ?? '(no note)'}`,
    );
  }

  console.log(
    '\n─ to remap, per concept, after deciding what these rows were ─────\n' +
      "  UPDATE salary_components SET component_type = 'HOUSING'\n" +
      "   WHERE component_type = 'OTHER' AND note ILIKE '%housing%';\n\n" +
      '  Re-run this report afterwards to confirm the split closed.\n',
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

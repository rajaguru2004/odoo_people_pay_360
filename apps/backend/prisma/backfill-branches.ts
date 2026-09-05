/**
 * One-off, idempotent multi-branch data backfill (db-push workflow — no migration DML).
 *   1. Ensure the default "Head Office" branch exists, copying current global
 *      system settings into its per-branch config.
 *   2. Assign every branch-less employee to Head Office.
 *   3. Stamp every branch-less attendance with its employee's branch.
 *   4. Grandfather existing ADMINs to all-branch (global) access.
 *   5. Grant ADMIN/HR_MANAGER an explicit access row to Head Office.
 * Safe to run multiple times. Run: npx ts-node prisma/backfill-branches.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🏬 Multi-branch backfill starting...');

  // 1. Default branch (copy global config on first creation) ----------------
  let branch = await prisma.branch.findFirst({ where: { code: 'HO' } });
  if (!branch) {
    const rows = await prisma.systemSetting.findMany({
      where: {
        key: {
          in: [
            'system_timezone',
            'office_start_time',
            'office_end_time',
            'geofencing_enabled',
            'office_latitude',
            'office_longitude',
            'geofencing_radius_meters',
          ],
        },
      },
    });
    const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const num = (v?: string) =>
      v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : null;
    branch = await prisma.branch.create({
      data: {
        code: 'HO',
        name: 'Head Office',
        description: 'Default branch (migrated from global system settings)',
        isActive: true,
        timezone: s['system_timezone'] ?? null,
        officeStartTime: s['office_start_time'] ?? null,
        officeEndTime: s['office_end_time'] ?? null,
        geofencingEnabled:
          s['geofencing_enabled'] !== undefined ? s['geofencing_enabled'] === 'true' : null,
        latitude: num(s['office_latitude']),
        longitude: num(s['office_longitude']),
        geofenceRadiusM: num(s['geofencing_radius_meters']) ?? null,
      },
    });
    console.log(`  ✅ Created Head Office branch (${branch.id}).`);
  } else {
    console.log(`  ↩︎  Head Office branch already exists (${branch.id}).`);
  }

  // 2. Employees ------------------------------------------------------------
  const emp = await prisma.employee.updateMany({
    where: { branchId: null },
    data: { branchId: branch.id },
  });
  console.log(`  ✅ Backfilled ${emp.count} employees -> Head Office.`);

  // 3. Attendances ----------------------------------------------------------
  const att = await prisma.$executeRaw`
    UPDATE "attendances" a SET "branch_id" = e."branch_id"
    FROM "employees" e
    WHERE a."employee_id" = e."id" AND a."branch_id" IS NULL`;
  console.log(`  ✅ Backfilled ${att} attendances.`);

  // 4. Grandfather existing admins to global access -------------------------
  const glob = await prisma.user.updateMany({
    where: { role: 'ADMIN', isGlobalBranchAccess: false },
    data: { isGlobalBranchAccess: true },
  });
  console.log(`  ✅ Granted global branch access to ${glob.count} admins.`);

  // 5. Explicit access grants for privileged roles --------------------------
  const privileged = await prisma.user.findMany({
    where: { role: { in: ['ADMIN', 'HR_MANAGER'] } },
    select: { id: true },
  });
  let grants = 0;
  for (const u of privileged) {
    const res = await prisma.userBranchAccess.upsert({
      where: { userId_branchId: { userId: u.id, branchId: branch.id } },
      update: {},
      create: { userId: u.id, branchId: branch.id },
    });
    if (res) grants++;
  }
  console.log(`  ✅ Ensured ${grants} privileged users have Head Office access.`);

  console.log('🏬 Multi-branch backfill complete.');
}

main()
  .catch((e) => {
    console.error('❌ Backfill failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

/**
 * One-time repair for employees hard-deleted BEFORE EmployeesService.hardDelete
 * started releasing the login email.
 *
 * User.employeeId is onDelete: SetNull, so deleting an Employee left the User
 * row behind still holding the person's address on a UNIQUE column. Creating
 * the employee again then failed with "User email already exists".
 *
 * This releases those addresses: each affected user is anonymized to
 * deleted+<id>@deleted.invalid and deactivated, then the row is deleted
 * outright when no retained record (leave approval, termination request,
 * contract appendix, task attachment...) still references it.
 *
 *   npx ts-node scripts/purge-orphan-user-emails.ts            # dry run
 *   npx ts-node scripts/purge-orphan-user-emails.ts --commit
 *   npx ts-node scripts/purge-orphan-user-emails.ts --commit --email a@b.com
 *
 * An unlinked user is NOT automatically an orphan: standalone ADMIN/HR logins
 * legitimately have employeeId = null. Only users whose email matches no
 * employee AND whose role is EMPLOYEE are touched, unless --email names one
 * explicitly.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const COMMIT = process.argv.includes('--commit');
const emailArgIndex = process.argv.indexOf('--email');
const TARGET_EMAIL =
  emailArgIndex !== -1 ? process.argv[emailArgIndex + 1] : undefined;

async function main() {
  console.log('=== Orphan user email purge ===');
  console.log(`Mode: ${COMMIT ? 'COMMIT' : 'DRY RUN (no changes)'}`);
  if (TARGET_EMAIL) console.log(`Target: ${TARGET_EMAIL}`);

  const candidates = await prisma.user.findMany({
    where: TARGET_EMAIL
      ? { email: TARGET_EMAIL }
      : { employeeId: null, role: 'EMPLOYEE' },
    select: { id: true, email: true, role: true, employeeId: true },
  });

  const orphans: typeof candidates = [];
  for (const user of candidates) {
    if (user.employeeId) {
      console.log(`SKIP ${user.email}: still linked to employee ${user.employeeId}`);
      continue;
    }
    if (user.email.endsWith('@deleted.invalid')) continue;
    const employee = await prisma.employee.findUnique({
      where: { email: user.email },
      select: { id: true },
    });
    if (employee) {
      console.log(`SKIP ${user.email}: an employee still holds this email`);
      continue;
    }
    orphans.push(user);
  }

  console.log(`\nOrphan logins holding a reusable email: ${orphans.length}`);
  for (const user of orphans) console.log(`  ${user.email} (${user.role}, ${user.id})`);

  if (!COMMIT) {
    console.log('\nDry run — re-run with --commit to apply.');
    return;
  }

  for (const user of orphans) {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        email: `deleted+${user.id}@deleted.invalid`,
        isActive: false,
        isEmailVerified: false,
        emailVerificationToken: null,
      },
    });
    const purged = await prisma.user
      .delete({ where: { id: user.id } })
      .then(() => true)
      .catch(() => false);
    console.log(
      `${user.email} -> released${purged ? ' and row deleted' : ' (tombstone kept: still referenced)'}`,
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

import { PrismaService } from '../../src/prisma/prisma.service';

const KEY = 'supervisor_approval_enabled';

/**
 * `supervisor_approval_enabled` is SHARED, environment-wide configuration, and
 * the databases these suites run against are also used for demos — a spec that
 * resets it to a hardcoded default silently disables every configured approval
 * chain in that environment (and with it the "Approvals" screen for every
 * supervisor and department manager).
 *
 * Snapshot it with {@link readApprovalSwitch} before touching it, and put it
 * back with {@link restoreApprovalSwitch} on teardown. `null` means the setting
 * did not exist and should not exist afterwards either.
 */
export async function readApprovalSwitch(
  prisma: PrismaService,
): Promise<string | null> {
  const row = await prisma.systemSetting.findUnique({ where: { key: KEY } });
  return row?.value ?? null;
}

export async function restoreApprovalSwitch(
  prisma: PrismaService,
  original: string | null,
): Promise<void> {
  if (original === null) {
    await prisma.systemSetting.deleteMany({ where: { key: KEY } });
    return;
  }
  await prisma.systemSetting.upsert({
    where: { key: KEY },
    update: { value: original },
    create: { key: KEY, value: original },
  });
}

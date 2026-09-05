import { E2EContext } from './e2e-app';

/**
 * Harness shared by every module's e2e suite: an auth header helper and
 * snapshot/restore for a `system_settings` row.
 *
 * These lived in `org-fixtures.ts` while Organization was the only module using
 * them. They are harness, not fixtures — nothing here knows about departments —
 * so People (and whatever comes after) imports them from here rather than
 * reaching into a neighbour's fixture file. `org-fixtures.ts` re-exports them
 * unchanged so no existing call site had to move.
 */

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/**
 * `null` means the row did not exist, which is not the same as an empty value:
 * restoring it has to DELETE the row, not write one.
 *
 * The distinction matters because e2e runs `maxWorkers: 1` — a suite that
 * changes a setting without putting it back exactly as it found it hands the new
 * value to every suite that follows.
 */
export type SettingSnapshot = string | null;

export async function readSetting(
  ctx: E2EContext,
  key: string,
): Promise<SettingSnapshot> {
  const row = await ctx.prisma.systemSetting.findUnique({ where: { key } });
  return row?.value ?? null;
}

export async function writeSetting(
  ctx: E2EContext,
  key: string,
  value: string,
): Promise<void> {
  await ctx.prisma.systemSetting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

export async function restoreSetting(
  ctx: E2EContext,
  key: string,
  previous: SettingSnapshot,
): Promise<void> {
  if (previous === null) {
    await ctx.prisma.systemSetting
      .delete({ where: { key } })
      .catch(() => undefined);
    return;
  }
  await ctx.prisma.systemSetting.update({
    where: { key },
    data: { value: previous },
  });
}

/** Runs `fn` with `key` set to `value`, and puts the row back either way. */
export async function withSetting<T>(
  ctx: E2EContext,
  key: string,
  value: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = await readSetting(ctx, key);
  await writeSetting(ctx, key, value);
  try {
    return await fn();
  } finally {
    await restoreSetting(ctx, key, previous);
  }
}

/**
 * Same as `withSetting` for several keys at once, restored in reverse order.
 * Several suites need this: a rule that reads more than one switch cannot be
 * exercised by moving them one at a time.
 */
export async function withSettings<T>(
  ctx: E2EContext,
  entries: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  const keys = Object.keys(entries);
  const previous: SettingSnapshot[] = [];
  for (const key of keys) {
    previous.push(await readSetting(ctx, key));
    await writeSetting(ctx, key, entries[key]);
  }
  try {
    return await fn();
  } finally {
    for (let i = keys.length - 1; i >= 0; i--) {
      await restoreSetting(ctx, keys[i], previous[i]);
    }
  }
}

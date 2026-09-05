/**
 * Snapshot/restore for `employee_template_enabled`.
 *
 * The flag is a single row in `system_settings`, which makes it environment-wide
 * shared state — exactly like `supervisor_approval_enabled` and its
 * `approval-switch.ts`. e2e runs with `maxWorkers: 1`, so a suite that leaves
 * the flag on hands the feature, switched on, to every suite after it.
 *
 * The subtlety worth encoding: restoring with
 *
 *     if (previous !== null) await update({ value: previous })
 *
 * is a no-op on a database where the row did not exist beforehand — a fresh
 * clone, a colleague's machine, a CI volume. There the suite creates the row,
 * turns it on, and then "restores" nothing, so it leaks ON and every later suite
 * silently runs with the template active. `restoreTemplateFlag` deletes the row
 * in that case, which is what "put it back how you found it" actually means.
 */
import { E2EContext } from './e2e-app';

export const TEMPLATE_FLAG = 'employee_template_enabled';

/** `null` means the row did not exist — which is NOT the same as `'false'`. */
export type TemplateFlagSnapshot = string | null;

export async function readTemplateFlag(
  ctx: E2EContext,
): Promise<TemplateFlagSnapshot> {
  const row = await ctx.prisma.systemSetting.findUnique({
    where: { key: TEMPLATE_FLAG },
  });
  return row?.value ?? null;
}

export async function setTemplateFlag(
  ctx: E2EContext,
  on: boolean,
): Promise<void> {
  const value = on ? 'true' : 'false';
  await ctx.prisma.systemSetting.upsert({
    where: { key: TEMPLATE_FLAG },
    create: { key: TEMPLATE_FLAG, value },
    update: { value },
  });
}

export async function restoreTemplateFlag(
  ctx: E2EContext,
  previous: TemplateFlagSnapshot,
): Promise<void> {
  if (previous === null) {
    await ctx.prisma.systemSetting
      .delete({ where: { key: TEMPLATE_FLAG } })
      .catch(() => undefined); // already absent is the desired end state
    return;
  }
  await ctx.prisma.systemSetting.update({
    where: { key: TEMPLATE_FLAG },
    data: { value: previous },
  });
}

/**
 * Call in a global `afterAll` to prove the suite put the flag back. Throws with
 * the drift spelled out rather than letting the next suite inherit it.
 */
export async function assertTemplateFlagRestored(
  ctx: E2EContext,
  previous: TemplateFlagSnapshot,
): Promise<void> {
  const now = await readTemplateFlag(ctx);
  if (now !== previous) {
    throw new Error(
      `${TEMPLATE_FLAG} leaked: expected ${JSON.stringify(previous)}, found ${JSON.stringify(now)}`,
    );
  }
}

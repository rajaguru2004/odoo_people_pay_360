/**
 * Which columns can actually hold NULL, read from the Prisma schema itself.
 *
 * "Optional to fill in" and "accepts NULL" are different properties, and
 * conflating them produced a 500:
 *
 *   numberOfChildren Int @default(0)
 *
 * A user never has to supply it, so every layer treated it as optional — but
 * the column is NOT NULL, so clearing the field sent `null` and Prisma rejected
 * the whole upsert. The error it reports for this is `Argument 'employee' is
 * missing`, because one unmatchable field makes the object fail to match
 * `UncheckedCreateInput` and Prisma falls back to describing the checked
 * variant. Nothing in that message mentions the field that actually caused it.
 *
 * Derived from `Prisma.dmmf` rather than a hand-kept list, for the same reason
 * `employee-bound-columns.spec.ts` verifies itself against the dmmf: a list
 * would drift the first time someone made a column nullable.
 */
import { Prisma } from '@prisma/client';

const cache = new Map<string, Set<string>>();

/**
 * Scalar columns on `modelName` that reject NULL — i.e. required in the schema,
 * whether or not they carry a default.
 */
export function notNullColumns(modelName: string): Set<string> {
  const hit = cache.get(modelName);
  if (hit) return hit;

  const model = Prisma.dmmf.datamodel.models.find((m) => m.name === modelName);
  if (!model) {
    throw new Error(`Model ${modelName} not found in Prisma dmmf`);
  }

  const set = new Set(
    model.fields
      .filter((f) => (f.kind === 'scalar' || f.kind === 'enum') && f.isRequired)
      .map((f) => f.name),
  );
  cache.set(modelName, set);
  return set;
}

/**
 * Drop keys explicitly set to `null` that the column cannot store.
 *
 * Dropped rather than coerced to the column default: writing 0 because someone
 * cleared a box is a guess about intent, and a silent wrong number on a
 * dependants count is worse than the field staying as it was. Undefined keys
 * are untouched — Prisma already reads those as "leave alone".
 */
export function stripUnsettableNulls<T extends Record<string, unknown>>(
  data: T,
  modelName: string,
): T {
  const notNull = notNullColumns(modelName);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === null && notNull.has(key)) continue;
    out[key] = value;
  }
  return out as T;
}

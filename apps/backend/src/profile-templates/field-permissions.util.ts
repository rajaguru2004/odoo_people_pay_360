/**
 * Per-field visibility and editability.
 *
 * Enforced at the SERVICE boundary rather than in a guard, because the decision
 * needs the resolved template — a guard runs before we know which template
 * applies to the employee being touched.
 *
 * This replaces the hardcoded self-service allowlist that used to sit inline in
 * EmployeesController (`const { phone, address, dateOfBirth, timezone,
 * dateFormat } = dto`): the same five fields are now `selfEditable: true` in the
 * shipped baseline, and an admin can widen or narrow that without a deploy.
 *
 * An empty roles array means "every role" — NOT "no role". That is the same
 * convention `visibleToRoles` uses in the schema, and inverting it would hide
 * every field on a freshly seeded template.
 */
import { ForbiddenException } from '@nestjs/common';
import { ResolvedField } from './profile-template.types';

export interface FieldActor {
  role: string;
  /** True when the actor is editing their own employee record. */
  isSelf: boolean;
}

/** ADMIN is not special-cased: a field hidden from ADMIN really is hidden. */
export function canViewField(f: ResolvedField, actor: FieldActor): boolean {
  if (actor.isSelf && !f.selfVisible) return false;
  if (f.visibleToRoles.length === 0) return true;
  if (f.visibleToRoles.includes(actor.role)) return true;
  // A self-service viewer passes on `selfVisible` alone, so an employee can see
  // their own emergency contact without the template naming EMPLOYEE explicitly.
  return actor.isSelf && f.selfVisible;
}

export function canEditField(f: ResolvedField, actor: FieldActor): boolean {
  if (!canViewField(f, actor)) return false;
  if (actor.isSelf) return f.selfEditable;
  if (f.editableByRoles.length === 0) return true;
  return f.editableByRoles.includes(actor.role);
}

/** The subset of a template an actor may see, for rendering and for reads. */
export function visibleFields(
  fields: ResolvedField[],
  actor: FieldActor,
): ResolvedField[] {
  return fields.filter((f) => canViewField(f, actor));
}

/**
 * Strip values the actor may not see from an employee-shaped row.
 *
 * Only touches keys the template governs: relations, ids and timestamps pass
 * through untouched, so this can be applied to a full `findOne` payload without
 * knowing its shape.
 */
export function projectEmployeeForRole<T extends Record<string, any>>(
  row: T,
  fields: ResolvedField[],
  actor: FieldActor,
): T {
  if (!row) return row;
  const out: Record<string, any> = { ...row };

  const customIn = (row.customFields ?? {}) as Record<string, unknown>;
  const customOut: Record<string, unknown> = {};
  let touchedCustom = false;

  for (const f of fields) {
    if (canViewField(f, actor)) {
      if (f.storage === 'JSONB' && f.fieldKey in customIn) {
        customOut[f.fieldKey] = customIn[f.fieldKey];
      }
      continue;
    }
    if (f.storage === 'JSONB') {
      touchedCustom = true;
      continue;
    }
    // Bound: drop the DTO-named property and, for profile-table fields, the
    // same key nested under `profile`.
    delete out[f.fieldKey];
    if (out.profile && typeof out.profile === 'object') {
      out.profile = { ...out.profile };
      delete (out.profile as Record<string, unknown>)[f.fieldKey];
    }
  }

  // Rebuild the bag only when the template governs at least one JSONB field, so
  // an employee with values under a since-deleted key does not lose them here.
  if (touchedCustom || Object.keys(customOut).length > 0) {
    out.customFields = customOut;
  }

  return out as T;
}

export class FieldPermissionError extends ForbiddenException {
  constructor(public readonly fields: string[]) {
    super(
      `You may not edit the following field${fields.length > 1 ? 's' : ''}: ${fields.join(', ')}`,
    );
  }
}

/**
 * Reject a write that touches fields the actor may not edit.
 *
 * Throws with EVERY offending key rather than the first, so a caller fixing a
 * form does not discover them one round-trip at a time.
 */
export function assertFieldsWritable(
  patch: Record<string, unknown>,
  fields: ResolvedField[],
  actor: FieldActor,
): void {
  const byKey = new Map(fields.map((f) => [f.fieldKey, f]));
  const denied: string[] = [];

  for (const key of Object.keys(patch)) {
    const field = byKey.get(key);
    // A key the template does not govern is not this function's business —
    // validateDynamicData rejects unknown keys, and non-template properties
    // (contract, salary components) are handled by their own endpoints.
    if (!field) continue;
    if (!canEditField(field, actor)) denied.push(key);
  }

  if (denied.length) throw new FieldPermissionError(denied);
}

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { LoanAccessService } from './loan-access.service';

/** Verbs that change something. Mirrors the audit interceptor's own list. */
const MUTATING_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

export const ALLOW_READ_ONLY_KEY = 'loan:allow-read-only';

/**
 * Marks a route that uses a mutating verb but persists nothing, so a read-only
 * auditor may still call it (the what-if eligibility check is the only one
 * today). Applied per handler; without it every POST/PUT/PATCH/DELETE on a
 * guarded controller is closed to auditors.
 */
export const AllowReadOnly = () => SetMetadata(ALLOW_READ_ONLY_KEY, true);

/** The one sentence an auditor sees. Exported so tests assert the exact text. */
export const READ_ONLY_REFUSAL =
  'Your account has read-only (auditor) access to advances and loans. ' +
  'You can view requests, schedules and reports, but you cannot create or ' +
  'change them.';

/**
 * Enforces the second half of the auditor grant.
 *
 * `advance_loan_auditor_roles` / `advance_loan_auditor_user_ids` hand out a
 * read of the whole loan book, and the module documented that grant as
 * read-only — but `LoanAccessService.isReadOnly()` had no caller anywhere in
 * the source (defect §8), so naming a role that ALREADY held write access as an
 * auditor was silently a no-op: the caller was read-only by the service's own
 * reckoning and could still move money.
 *
 * A guard rather than a call at the top of ~20 controller methods, because:
 *   • it cannot be forgotten on the next route added to these controllers —
 *     the check is by HTTP verb, so a new POST is closed by default; and
 *   • it refuses BEFORE the handler runs, so nothing is half-written when the
 *     refusal is decided. The @Roles / RolesGuard pair already establishes the
 *     precedent for authorization living in a guard here.
 *
 * It deliberately does NOT overlap with RolesGuard: @Roles answers "is this
 * role allowed on this route at all", this answers "has this particular caller
 * been declared an observer". Both must pass. Order is irrelevant — either
 * refusal is a 403 — but this one runs last so the message a legitimately
 * unprivileged caller sees is unchanged.
 *
 * Which auditor grant beats which role is decided in `isReadOnly()`; see the
 * comment there. Short version: a user id named individually binds everyone
 * including ADMIN; a role-wide grant binds everyone EXCEPT ADMIN, so a
 * mis-typed setting can never leave the system with no one able to act.
 */
@Injectable()
export class LoanReadOnlyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: LoanAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    // Reads are the whole point of the auditor grant.
    if (!MUTATING_METHODS.includes(request.method)) return true;

    if (
      this.reflector.getAllAndOverride<boolean>(ALLOW_READ_ONLY_KEY, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return true;
    }

    // No user means JwtAuthGuard has not run or has already refused; deciding
    // "read-only" on an anonymous request would answer 403 where the correct
    // answer is 401.
    const user = request.user;
    if (!user) return true;

    if (await this.access.isReadOnly(user)) {
      throw new ForbiddenException(READ_ONLY_REFUSAL);
    }
    return true;
  }
}

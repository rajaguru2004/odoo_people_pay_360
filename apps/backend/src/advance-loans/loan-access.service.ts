import { ForbiddenException, Injectable } from '@nestjs/common';
import { isDeptInManagerScope } from '../common/services/manager-scope.util';
import { SystemSettingsService } from '../system-settings/system-settings.service';

/** The minimum shape a caller must supply to be authorized against a loan. */
export interface LoanAccessSubject {
  employeeId: string;
  employee?: { departmentId?: string | null } | null;
}

/**
 * The ONE place that answers "may this user see / act on this loan?".
 *
 * It exists because the predicate used to be written inline in
 * `advance-loans.service.findOne`, and `advance-loan-attachments.findByRequest`
 * simply did not repeat it — so any authenticated employee who obtained a loan
 * id could list a colleague's attachment filenames and URLs. Duplication WAS
 * the bug; every read path now funnels through here.
 *
 * Finance and auditor are settings-driven rather than new Role enum values:
 * `User.role` is a VarChar whose allowed set is hardcoded in five DTOs and the
 * MCP role union, and dozens of `['ADMIN','HR_MANAGER'].includes(...)` checks
 * across unrelated services would silently deny a new role everywhere outside
 * loans. This mirrors the existing `advance_loan_approver_roles` precedent.
 */
@Injectable()
export class LoanAccessService {
  constructor(private settings: SystemSettingsService) {}

  private async csv(key: string, fallback: string): Promise<string[]> {
    const raw = await this.settings.getSetting(key, fallback);
    return raw
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
  }

  async financeRoles(): Promise<string[]> {
    return this.csv('advance_loan_finance_roles', 'ADMIN');
  }

  async auditorRoles(): Promise<string[]> {
    return this.csv('advance_loan_auditor_roles', '');
  }

  async auditorUserIds(): Promise<string[]> {
    return this.csv('advance_loan_auditor_user_ids', '');
  }

  async writeOffRoles(): Promise<string[]> {
    return this.csv('advance_loan_writeoff_roles', 'ADMIN');
  }

  /** True for a caller who may read every loan inside their branch envelope. */
  async canViewAll(user: any): Promise<boolean> {
    if (['ADMIN', 'HR_MANAGER'].includes(user?.role)) return true;
    const [finance, auditors, auditorIds] = await Promise.all([
      this.financeRoles(),
      this.auditorRoles(),
      this.auditorUserIds(),
    ]);
    return (
      finance.includes(user?.role) ||
      auditors.includes(user?.role) ||
      auditorIds.includes(String(user?.id).toUpperCase())
    );
  }

  /**
   * True for a caller who may read the loan book but must be refused every
   * mutating loan route. Enforced by `LoanReadOnlyGuard`, which sits on the
   * loan controllers — see `loan-readonly.guard.ts`.
   *
   * The two auditor settings are deliberately NOT symmetric, because they are
   * not the same kind of statement:
   *
   *   • `advance_loan_auditor_user_ids` names ONE HUMAN. Nobody types a UUID by
   *     accident, so it is read as "this account is an observer" and it wins
   *     over everything, ADMIN included. An operator who locks their own admin
   *     account out of loan writes this way lifts it again from
   *     `/system-settings`, a different module which no loan guard gates — so
   *     the mistake is recoverable without a DB console.
   *
   *   • `advance_loan_auditor_roles` names a WHOLE ROLE, and it does take that
   *     role's write access away — otherwise §8 stays open. The one carve-out
   *     is ADMIN, which keeps its write: listing ADMIN here is far more likely
   *     to be a fat-fingered "everyone should be able to audit" than a
   *     deliberate decision to freeze every money operation in the system, and
   *     the frozen state leaves nobody able to thaw a loan. An ADMIN who really
   *     must be an observer is named in the per-user list above, which does
   *     bind them.
   *
   * Note the asymmetry with `canViewAll` on purpose: an auditor of either kind
   * READS everything (that is the point of the setting) — this method answers
   * only the second half, "may they also write?".
   */
  async isReadOnly(user: any): Promise<boolean> {
    const [auditors, auditorIds] = await Promise.all([
      this.auditorRoles(),
      this.auditorUserIds(),
    ]);

    // Named individually — binding on every role, including ADMIN.
    if (auditorIds.includes(String(user?.id).toUpperCase())) return true;

    if (!auditors.includes(String(user?.role).toUpperCase())) return false;

    // Named by role — everyone but ADMIN, so the system is never left with
    // nobody who can act on a loan.
    return String(user?.role).toUpperCase() !== 'ADMIN';
  }

  /**
   * Throw unless `user` may view `request`.
   *
   * Branch scoping is a SEPARATE concern and is asserted by the caller with
   * assertInBranch (which 404s rather than 403s, so it does not leak existence).
   * This method covers the intra-branch horizontal check.
   */
  async assertCanViewLoan(request: LoanAccessSubject, user: any) {
    const isOwner =
      !!user?.employeeId && request.employeeId === user.employeeId;
    if (isOwner) return;

    if (await this.canViewAll(user)) return;

    if (
      user?.role === 'MANAGER' &&
      isDeptInManagerScope(user, request.employee?.departmentId ?? null)
    ) {
      return;
    }

    throw new ForbiddenException(
      'You do not have permission to view this advance/loan request',
    );
  }
}

import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupPayrollFixtures,
  seedAttendance,
  PayrollFixtures,
  VALID_OM_IBAN,
  bearer,
} from './utils/payroll-fixtures';

/**
 * The seams around payroll — Phase 4, chunk C7.
 *
 * Everything here is asserted from the PAYROLL side. The loan module has its own
 * 120-case suite, attendance and overtime have theirs; what none of them can
 * prove is that the contract BETWEEN them and a payroll run holds.
 *
 * The centrepiece is `assertBankEditable` — the guard that freezes an employee's
 * bank details while their money is in motion. It is the highest-value
 * cross-domain rule in the module because it spans three subsystems and its
 * failure mode is silent: a salary paid into an account the employee no longer
 * owns.
 *
 * The truth table it implements:
 *
 * | in-flight thing                        | bank change |
 * |----------------------------------------|-------------|
 * | payroll DRAFT / PENDING_APPROVAL / APPROVED | 409    |
 * | payroll LOCKED / REJECTED              | allowed     |
 * | WPS file GENERATING / GENERATED / SUBMITTED | 409    |
 * | WPS row flipped REJECTED by the bank   | allowed, that employee only |
 * | employee has NO active detail, migration path | allowed (`exemptFirstTime`) |
 */

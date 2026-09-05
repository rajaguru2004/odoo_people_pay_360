import { AssetStatus } from '@prisma/client';
import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { bearer } from './utils/fixtures';
import { withSetting, withSettings } from './utils/settings';
import {
  setupWorkplaceFixtures,
  WorkplaceFixtures,
} from './utils/workplace-fixtures';
import { RemindersService } from '../src/reminders/reminders.service';
import { AssetWarrantyReminderSource } from '../src/reminders/sources/asset-warranty-reminder.source';

/**
 * WP-2 — the offboarding clearance gate (`CLR-API-*`).
 *
 * `src/assets/clearance.service.ts` is the sharpest production consequence in
 * the Workplace module: it is the one piece of code that can REFUSE to end an
 * employment. `test/asset-clearance.e2e-spec.ts` proves the happy shape of that
 * — one asset, three paths, one override. This file proves the parts that
 * decide whether the control is real:
 *
 *   1. The gate matrix, twice over. All three offboarding paths refused while
 *      an assignment is open, then all three admitted once it is returned, with
 *      the RETURN as the only difference between the halves. A control that
 *      passes only the "blocked" half is indistinguishable from an endpoint
 *      that is broken for everyone.
 *   2. The two kill switches, INDEPENDENTLY. `clearance_blocking_enabled`
 *      releases everything; `loan_clearance_blocking_enabled` must release the
 *      loan half and leave the asset half intact. A site that stops chasing
 *      salary advances must not thereby stop chasing laptops.
 *   3. Loan statuses. Money is only actually out in
 *      `APPROVED|DISBURSED|ACTIVE|ON_HOLD`; a SETTLED or REJECTED request has a
 *      principal figure but no debt, and blocking on those would make the gate
 *      unusable. Driven through real `AdvanceLoanRequest` rows, because the
 *      status list is a string array in the service and a typo in it is exactly
 *      the kind of thing only a real row catches.
 *   4. The override: BOTH a reason AND an OVERRIDE_ROLE, always audited.
 *   5. `getClearanceStatus` keyed on `returnedAt IS NULL` and never on
 *      `Employee.status` — asserted head-on with an INACTIVE employee who is
 *      still holding, because that is the rule most likely to be "simplified"
 *      into a status check by a later change.
 *   6. Who may ask, and what a stranger's id answers.
 *   7. XM-API-12, the warranty reminder source that keeps the register honest
 *      between offboardings.
 *   8. Branch scope on the read — the one that used to produce a FALSE
 *      CLEARANCE rather than a refusal, which is the failure mode nobody
 *      notices.
 *
 * FINDINGS. Four defects this file pinned are now FIXED, and each pin has been
 * collapsed with its `it.failing` twin into a single case asserting the correct
 * behaviour, keeping the finding's own id and a comment recording what the
 * defect was (docs/TESTING.md, "Recorded defects"):
 *
 *   R26  CLR-API-39  no branch check on the clearance read — a scoped HR was
 *                    told a foreign employee owed nothing. Now 404.
 *   R27  CLR-API-37  an unknown employeeId answered `cleared:true`. Now 404.
 *   R28  CLR-API-34  the MANAGER read was not department-scoped. Now 403.
 *   R29  CLR-API-26  the CLEARANCE_OVERRIDDEN audit row dropped the loan half.
 *                    Now carries `outstandingLoans` beside `openAssets`.
 *
 * No `it.failing` remains in this file, which is the point of the convention:
 * a twin that would now pass is a pin that has to go.
 *
 * SETTINGS DISCIPLINE. `clearance_blocking_enabled`,
 * `loan_clearance_blocking_enabled` and `reminder_days_asset_warranty` are
 * GLOBAL rows shared with every other suite. Every flip below is wrapped around
 * ONE case (never a describe block) via `withSetting`/`withSettings`, which
 * restore in a `finally`. A suite that leaves one flipped fails a file that
 * never touched it.
 */

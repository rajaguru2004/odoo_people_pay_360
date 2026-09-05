-- Paying the end-of-service benefit through the payroll run.
--
-- Gratuity is a PROVISION and normally never touches a payslip: it is set aside
-- monthly and settled outside payroll on exit, which is why nothing in the
-- engine has ever added it to a net.
--
-- But whether the exit payout must appear in the wage file the bank receives is
-- a jurisdiction question, not an engineering one, and it differs by client.
-- `payroll_eosb_pay_through_final_run` decides it; this column is where the
-- amount lands when the answer is yes.
--
-- Its own column, for the same reason `leave_encashment` and `other_recovery`
-- have theirs: folding it into `bonus` would overload a column that means
-- rewards, and folding it into `deduction`-adjacent arithmetic would put a
-- payment on the wrong side. Defaulted to 0, so with the setting off it
-- contributes nothing — `x + 0` is exact.
--
-- Only ever non-zero on a FINAL_SETTLEMENT run.
ALTER TABLE "payroll_items"
  ADD COLUMN "gratuity_payout" DECIMAL(12,2) NOT NULL DEFAULT 0;

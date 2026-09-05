'use client';

import React, { useState } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import advanceLoanService from '@/services/advanceLoanService';
import {
  AdvanceLoanRequest,
  LoanPayoffQuote,
  LoanScheduleRow,
} from '@/types/advanceLoan';
import { formatCurrency } from '@/utils/formatters';
import { toast } from '@/lib/toast';
import { apiErrorMessage } from '@/utils/apiError';
import { LoanOp as Op, validateLoanOp } from './loanGuards';

interface Props {
  loan: AdvanceLoanRequest;
  quote: LoanPayoffQuote | null;
  /** The live schedule, so a skip can be judged before it is sent. */
  schedule?: LoanScheduleRow[];
  canManage: boolean;
  canWriteOff: boolean;
  onDone: () => void;
}

/** Statuses where money can still move. */
const LIVE = ['APPROVED', 'DISBURSED', 'ACTIVE', 'ON_HOLD'];

/**
 * `installmentNo` → `installment-no`, so the form fields carry hyphenated test
 * ids rather than the camelCase of the state key they happen to be stored under.
 */
const kebab = (key: string) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/**
 * How many buttons this component would render for a given loan.
 *
 * Exported so the page can decide whether to draw the Actions panel at all.
 * Without it the page rendered a headed, bordered, empty box for every request
 * that is not live — a rejected loan showed an "Actions" card with nothing in
 * it, which reads as a bug rather than as "there is nothing to do".
 */
export function countLoanActions(
  loan: Pick<AdvanceLoanRequest, 'status' | 'type'>,
  opts: { canManage: boolean; canWriteOff: boolean; outstanding: number },
): number {
  if (!opts.canManage) return 0;
  const isLive = LIVE.includes(loan.status);
  const isHeld = loan.status === 'ON_HOLD';
  const isWrittenOff = loan.status === 'WRITTEN_OFF';

  return [
    loan.status === 'APPROVED', // disburse
    isLive && !isHeld, // rate change
    isLive && !isHeld && loan.type === 'LOAN', // top up
    isLive && !isHeld, // prepay
    isLive && !isHeld, // skip
    isLive && !isHeld, // hold
    isHeld, // resume
    isLive && loan.type === 'ADVANCE', // convert
    isLive, // waive
    isLive && opts.outstanding <= 0, // foreclose
    isLive, // close
    isLive && opts.canWriteOff, // write off
    isWrittenOff && opts.canWriteOff, // reinstate
  ].filter(Boolean).length;
}

/** Why there is nothing to do, in the user's terms rather than the enum's. */
export function noActionsReason(status: string): string {
  switch (status) {
    case 'PENDING':
    case 'DRAFT':
      return 'Nothing to do here yet — this request is still waiting on approval. Approve or reject it from the requests list.';
    case 'REJECTED':
      return 'This request was rejected, so no money ever moved and there is nothing to operate on.';
    case 'CANCELLED':
      return 'This request was cancelled before it took effect.';
    case 'COMPLETED':
    case 'CLOSED':
    case 'SETTLED':
      return 'This loan is fully settled. Its schedule and recovery history below are kept for the record.';
    case 'WRITTEN_OFF':
      return 'The balance was written off. Only a user with write-off rights can reinstate it.';
    case 'RECEIVABLE':
      return 'This balance is being recovered outside payroll; there is no payroll operation left to run.';
    default:
      return 'There are no operations available for this request in its current state.';
  }
}

/**
 * Every post-approval money operation.
 *
 * Which buttons appear is driven by the loan's STATUS and the caller's
 * capability, not by guessing — the backend refuses anything else anyway, and
 * showing a button that always 409s is worse than not showing it. Write-off is
 * separated visually because it forgives company money.
 */
export default function LoanLifecycleActions({
  loan,
  quote,
  schedule = [],
  canManage,
  canWriteOff,
  onDone,
}: Props) {
  const [op, setOp] = useState<Op | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  /**
   * Why the reason is held in state and rendered in the dialog rather than left
   * to the toast: a toast is transient and lands away from the field that caused
   * it, so the explanation disappears while the user is still looking at the
   * form. A refusal is not a notification, it is part of the form's state.
   */
  const [problem, setProblem] = useState<string | null>(null);

  if (!canManage) return null;

  const isLive = LIVE.includes(loan.status);
  const isHeld = loan.status === 'ON_HOLD';
  const isWrittenOff = loan.status === 'WRITTEN_OFF';
  const outstanding = quote?.outstandingPrincipal ?? 0;

  const open = (next: Op) => {
    setForm({});
    setProblem(null);
    setOp(next);
  };

  const run = async (fn: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setProblem(null);
    try {
      await fn();
      toast.success(success);
      setOp(null);
      onDone();
    } catch (e: unknown) {
      // The backend explains every refusal precisely — which payroll run holds
      // the instalment, the exact payoff figure, which instalment numbers are
      // still open. `apiErrorMessage` is what actually reaches those strings:
      // our axios interceptor rejects with a FLAT object, so the natural-looking
      // `e.response.data.message` is always undefined and the fallback wins.
      // That is how "Instalment not found on the live schedule" reached
      // production as "The operation could not be completed".
      const message = apiErrorMessage(
        e,
        'The operation could not be completed. Reload the page and try again.',
      );
      // Kept on screen next to the inputs, and echoed to a toast for the case
      // where the dialog is scrolled past the banner.
      setProblem(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    const reason = form.reason ?? '';

    // Anything answerable from data already on screen is answered here, so the
    // user gets the reason immediately and keeps what they typed.
    if (op) {
      const blocked = validateLoanOp(op, form, { loan, quote, schedule });
      if (blocked) {
        setProblem(blocked);
        return undefined;
      }
    }

    switch (op) {
      case 'prepay':
        return run(
          () =>
            advanceLoanService.prepay(loan.id, {
              amount: Number(form.amount),
              mode: form.mode || 'BANK',
              reference: form.reference || undefined,
              recalc: (form.recalc as any) || undefined,
            }),
          'Prepayment recorded',
        );
      case 'close':
        return run(() => advanceLoanService.close(loan.id, reason), 'Loan closed');
      case 'foreclose':
        return run(
          () =>
            advanceLoanService.foreclose(loan.id, {
              waiveFutureInterest: form.waive === 'yes',
              reason,
            }),
          'Loan foreclosed',
        );
      case 'writeOff':
        return run(
          () =>
            advanceLoanService.writeOff(loan.id, {
              amount: form.amount ? Number(form.amount) : undefined,
              reason,
            }),
          'Balance written off',
        );
      case 'disburse':
        return run(
          () =>
            advanceLoanService.disburse(loan.id, {
              disbursementDate: form.disbursementDate || undefined,
              disbursedAmount: form.disbursedAmount
                ? Number(form.disbursedAmount)
                : undefined,
              reference: form.reference || undefined,
            }),
          'Payout recorded',
        );
      case 'rateChange':
        return run(
          () =>
            advanceLoanService.rateChange(loan.id, {
              newRate: Number(form.newRate),
              newMethod: form.newMethod || undefined,
              mode: (form.mode as 'KEEP_TENURE' | 'KEEP_EMI') || undefined,
              reason,
              // Only sent when the deployment asks for a second approver; the
              // server refuses without it and says so.
              authorisedBy: form.authorisedBy || undefined,
            }),
          'Interest changed',
        );
      case 'topup':
        return run(
          () =>
            advanceLoanService.topup(loan.id, {
              amount: Number(form.amount),
              installments: Number(form.installments),
              reason,
              authorisedBy: form.authorisedBy || undefined,
            }),
          'Loan topped up',
        );
      case 'reinstate':
        return run(
          () => advanceLoanService.reinstate(loan.id, reason),
          'Write-off reinstated',
        );
      case 'waive':
        return run(
          () =>
            advanceLoanService.waive(loan.id, {
              amount: form.amount ? Number(form.amount) : undefined,
              waiveType: (form.waiveType as any) || 'BOTH',
              reason,
            }),
          'Amount waived',
        );
      case 'hold':
        return run(
          () =>
            advanceLoanService.hold(loan.id, {
              reason,
              until: form.until || undefined,
            }),
          'Recovery paused',
        );
      case 'resume':
        return run(() => advanceLoanService.resume(loan.id, reason), 'Recovery resumed');
      case 'skip':
        return run(
          () =>
            advanceLoanService.skipInstallment(loan.id, {
              installmentNo: Number(form.installmentNo),
              mode: (form.mode as any) || 'EXTEND',
              reason,
            }),
          'Instalment skipped',
        );
      case 'convert':
        return run(
          () =>
            advanceLoanService.convert(loan.id, {
              installments: Number(form.installments),
              reason,
            }),
          'Advance converted; the new loan awaits approval',
        );
      default:
        return undefined;
    }
  };

  const field = (
    key: string,
    label: string,
    type = 'text',
    placeholder?: string,
  ) => (
    <label className="block">
      <span className="mb-1 block text-sm text-text-muted">{label}</span>
      <input
        data-testid={`loan-op-${kebab(key)}`}
        type={type}
        value={form[key] ?? ''}
        placeholder={placeholder}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        className="w-full rounded-lg border border-surface-border bg-surface-card px-3 py-2 text-sm"
      />
    </label>
  );

  const select = (key: string, label: string, options: [string, string][]) => (
    <label className="block">
      <span className="mb-1 block text-sm text-text-muted">{label}</span>
      <select
        data-testid={`loan-op-${kebab(key)}`}
        value={form[key] ?? options[0][0]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        className="w-full rounded-lg border border-surface-border bg-surface-card px-3 py-2 text-sm"
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );

  const reasonField = (label = 'Reason') =>
    field('reason', label, 'text', 'Recorded on the audit trail');

  /** Instalment numbers a skip may still target, ascending. */
  const openInstallments = schedule
    .filter((r) => r.status === 'SCHEDULED')
    .map((r) => r.installmentNo)
    .sort((a, b) => a - b);

  const BODY: Record<Op, { title: string; note?: string; body: React.ReactNode }> = {
    prepay: {
      title: 'Record a payment made outside payroll',
      note: `Applied to interest first. Paying the full ${formatCurrency(quote?.payoffAmount ?? 0)} closes the loan.`,
      body: (
        <>
          {field('amount', 'Amount', 'number')}
          {select('mode', 'Mode', [
            ['BANK', 'Bank transfer'],
            ['CASH', 'Cash'],
            ['CHEQUE', 'Cheque'],
            ['ADJUSTMENT', 'Adjustment'],
          ])}
          {field('reference', 'Reference', 'text', 'UTR / cheque number')}
          {select('recalc', 'Then', [
            ['REDUCE_TENURE', 'Keep the instalment, shorten the loan'],
            ['REDUCE_EMI', 'Keep the tenure, lower the instalment'],
          ])}
        </>
      ),
    },
    close: {
      title: 'Close this loan',
      note: 'Only allowed when the residual is within the rounding tolerance — the small leftover after a final instalment.',
      body: reasonField(),
    },
    foreclose: {
      title: 'Foreclose',
      note: 'For a loan whose principal is already fully repaid.',
      body: (
        <>
          {select('waive', 'Remaining interest', [
            ['no', 'Still payable'],
            ['yes', 'Waive it'],
          ])}
          {reasonField()}
        </>
      ),
    },
    writeOff: {
      title: 'Write off this balance',
      note: 'This permanently forgives company money. It is audited, and reversible only via Reinstate.',
      body: (
        <>
          {field('amount', `Amount (blank = all ${formatCurrency(outstanding)})`, 'number')}
          {reasonField('Reason (at least 10 characters)')}
        </>
      ),
    },
    reinstate: {
      title: 'Reinstate a written-off balance',
      body: reasonField(),
    },
    waive: {
      title: 'Waive part of the debt',
      body: (
        <>
          {select('waiveType', 'What to waive', [
            ['BOTH', 'Interest and principal'],
            ['INTEREST', 'Interest only'],
            ['PRINCIPAL', 'Principal only'],
          ])}
          {field('amount', 'Amount (blank = all of it)', 'number')}
          {reasonField()}
        </>
      ),
    },
    hold: {
      title: 'Pause payroll recovery',
      note: 'Payroll skips a held loan entirely until it is resumed.',
      body: (
        <>
          {field('until', 'Until (blank = until resumed)', 'date')}
          {reasonField()}
        </>
      ),
    },
    resume: { title: 'Resume payroll recovery', body: reasonField('Reason (optional)') },
    skip: {
      title: 'Skip one instalment',
      note: openInstallments.length
        ? `Extend still owes the money and pushes the tail out. Forgive waives it. Still open: ${openInstallments.join(', ')}.`
        : 'Extend still owes the money and pushes the tail out. Forgive waives it.',
      body: (
        <>
          {field(
            'installmentNo',
            openInstallments.length
              ? `Instalment number (${openInstallments[0]}–${openInstallments[openInstallments.length - 1]})`
              : 'Instalment number',
            'number',
          )}
          {select('mode', 'Mode', [
            ['EXTEND', 'Extend — still owed'],
            ['FORGIVE', 'Forgive — waived'],
          ])}
          {reasonField()}
        </>
      ),
    },
    disburse: {
      title: 'Record the payout',
      note: 'Moves the loan to DISBURSED and stamps the date the money actually moved. Any fee taken at source reduces what is handed over, never what is owed.',
      body: (
        <>
          {field('disbursementDate', 'Date paid out', 'date')}
          {field('disbursedAmount', 'Amount handed over (optional)', 'number')}
          {field('reference', 'Bank reference (optional)')}
        </>
      ),
    },
    rateChange: {
      title: 'Change the interest',
      note: 'Instalments already paid are never re-priced. KEEP_TENURE moves the instalment and holds the end date; KEEP_EMI holds the instalment and moves the end date.',
      body: (
        <>
          {select('newMethod', 'Interest method', [
            ['NONE', 'Interest-free'],
            ['FLAT', 'Flat'],
            ['REDUCING_BALANCE', 'Reducing balance'],
          ])}
          {field('newRate', 'New annual rate %', 'number')}
          {select('mode', 'What moves', [
            ['KEEP_TENURE', 'Keep the end date, change the instalment'],
            ['KEEP_EMI', 'Keep the instalment, change the end date'],
          ])}
          {reasonField('Reason')}
        </>
      ),
    },
    topup: {
      title: 'Top up this loan',
      note: 'The new principal settles this balance and only the difference is paid to the employee. This loan closes as TOPPED_UP.',
      body: (
        <>
          {field('amount', 'Total principal of the new loan', 'number')}
          {field('installments', 'Instalments', 'number')}
          {reasonField('Reason')}
        </>
      ),
    },
    convert: {
      title: 'Convert this advance into a loan',
      note: 'Creates a NEW request that re-enters approval; the advance is closed and the pair nets to zero.',
      body: (
        <>
          {field('installments', 'Instalments', 'number')}
          {reasonField('Reason (optional)')}
        </>
      ),
    },
  };

  const Btn = ({ to, children, danger }: { to: Op; children: React.ReactNode; danger?: boolean }) => (
    <button
      data-testid={`loan-op-${to}`}
      onClick={() => open(to)}
      className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
        danger
          ? 'border-status-error text-status-error hover:bg-status-error-bg'
          : 'border-surface-border hover:bg-surface-page'
      }`}
    >
      {children}
    </button>
  );

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {/* Only an APPROVED loan can be paid out; once DISBURSED the button
            has nothing left to do. */}
        {loan.status === 'APPROVED' && canManage && <Btn to="disburse">Record payout</Btn>}
        {isLive && !isHeld && <Btn to="prepay">Record payment</Btn>}
        {isLive && !isHeld && <Btn to="rateChange">Change interest</Btn>}
        {isLive && !isHeld && loan.type === 'LOAN' && <Btn to="topup">Top up</Btn>}
        {isLive && !isHeld && <Btn to="skip">Skip instalment</Btn>}
        {isLive && !isHeld && <Btn to="hold">Pause recovery</Btn>}
        {isHeld && <Btn to="resume">Resume recovery</Btn>}
        {isLive && loan.type === 'ADVANCE' && <Btn to="convert">Convert to loan</Btn>}
        {isLive && <Btn to="waive">Waive</Btn>}
        {isLive && outstanding <= 0 && <Btn to="foreclose">Foreclose</Btn>}
        {isLive && <Btn to="close">Close</Btn>}
        {isLive && canWriteOff && <Btn to="writeOff" danger>Write off</Btn>}
        {isWrittenOff && canWriteOff && <Btn to="reinstate">Reinstate</Btn>}
      </div>

      {op && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div
            data-testid="loan-op-modal"
            data-op={op}
            className="w-full max-w-md rounded-xl bg-surface-card p-5 shadow-xl"
          >
            <h3 className="mb-1 text-lg font-semibold">{BODY[op].title}</h3>
            {BODY[op].note && (
              <p className="mb-3 text-sm text-text-muted">{BODY[op].note}</p>
            )}

            {/* The refusal sits above the fields, where the eye already is, and
                stays until the next attempt. role="alert" so it is announced
                rather than only seen. */}
            {problem && (
              <div
                role="alert"
                data-testid="loan-op-error"
                className="mb-3 flex items-start gap-2 rounded-lg border border-status-error bg-status-error-bg px-3 py-2 text-sm text-status-error"
              >
                <AlertCircle size={16} className="mt-0.5 shrink-0" />
                <span>{problem}</span>
              </div>
            )}

            <div className="space-y-3">{BODY[op].body}</div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                data-testid="loan-op-cancel"
                onClick={() => setOp(null)}
                disabled={busy}
                className="rounded-lg border border-surface-border px-4 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                data-testid="loan-op-confirm"
                onClick={submit}
                disabled={busy}
                className="flex items-center gap-2 rounded-lg bg-brand-primary px-4 py-2 text-sm text-text-on-brand disabled:opacity-60"
              >
                {busy && <Loader2 size={14} className="animate-spin" />}
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

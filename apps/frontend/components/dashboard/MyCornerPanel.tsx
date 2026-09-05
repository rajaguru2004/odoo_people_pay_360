'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { CalendarCheck, ClipboardList, Clock, Wallet } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { STATUS_TONE, statusLabel } from '@/components/attendance/attendanceFormat';
import type { AttendanceStatus } from '@/types/attendance';
import { formatCurrency, formatNumber } from '@/utils/formatters';
import type { DashboardMe } from '@/types/dashboardOverview';

/**
 * The manager's own corner of the management dashboard.
 *
 * Everything else on this page is about other people — headcount, queues,
 * expiries, the payroll run. `me` is the one block of the overview payload that
 * arrives for EVERY role, because an admin or an HR manager is also an employee
 * with a shift, a leave balance and a payslip, and until this strip existed that
 * block had no consumer at all. Four questions, in the order somebody signing in
 * asks them about themselves: where do I stand today, how much leave is left, is
 * anything of mine still waiting, and what was I last paid.
 *
 * It sits ABOVE the KPI row and is deliberately quieter than one — small labels,
 * body-sized values, no hero figure and no sparkline. Two rows of cards
 * competing for the same glance is how a reader ends up believing their own
 * leave balance is a company-wide number.
 *
 * Three rules carry it, and all three are about not making a claim the payload
 * does not support:
 *
 * **A `null` figure is an em dash, never a zero.** "0 days of leave left" and
 * "we could not ask" are different statements and only one of them is ever true
 * at a time. `formatNumber` and `formatCurrency` already return `—` for null, so
 * the figures go through them unguarded rather than growing a second, slightly
 * different opinion about what unknown looks like here.
 *
 * **`employeeId: null` renders nothing at all.** See the guard below.
 *
 * **`failed` still draws the strip.** See the shell below.
 */

/** Whether a status string off the wire is one this app knows how to tint. */
function isKnownStatus(value: string): value is AttendanceStatus {
  return value in STATUS_TONE;
}

/**
 * One fact: a small label, a value, and the screen that answers it in full.
 *
 * A real anchor rather than an onClick, so a reader can middle-click their own
 * leave screen open beside the dashboard they are still reading.
 */
function Fact({
  label,
  href,
  icon,
  children,
}: {
  label: string;
  href: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className="group flex min-w-0 items-center gap-3 rounded-xl px-2 py-1.5 transition-colors hover:bg-surface-page"
    >
      <span
        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-primary/10 text-brand-primary"
        aria-hidden
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[10px] font-bold uppercase tracking-wider text-text-muted">
          {label}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[13px] font-semibold tabular-nums text-text-body">
          {children}
        </span>
      </span>
    </Link>
  );
}

/**
 * The same four slots, greyed.
 *
 * Borrowed from the panels beside it (`ExpiringSoonPanel`, `ApprovalsQueue`) and
 * `StatCard`'s row — one `animate-pulse` block on `bg-surface-page` — so the
 * page does not gain a third idea of what loading looks like. Same shape as the
 * loaded strip, so nothing below it moves when the data lands.
 */
function FactSkeleton() {
  return (
    <div className="flex items-center gap-3 px-2 py-1.5">
      <div className="h-8 w-8 shrink-0 animate-pulse rounded-lg bg-surface-page" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="h-2.5 w-16 animate-pulse rounded bg-surface-page" />
        <div className="h-3.5 w-24 animate-pulse rounded bg-surface-page" />
      </div>
    </div>
  );
}

export default function MyCornerPanel({
  me,
  currency,
  loading,
  failed,
}: {
  me?: DashboardMe;
  /**
   * The company unit, and only a fallback here. The payslip carries its own
   * currency and is formatted in THAT — see the payslip fact below.
   */
  currency: string;
  loading?: boolean;
  failed?: boolean;
}) {
  /**
   * An account with no employee record behind it — a bare admin, a service
   * login — gets no strip at all.
   *
   * There is no "your day" for something that is not a person: no shift, no
   * balance, no payslip, and none of it is coming. Drawing the row anyway would
   * fill it with four em dashes, and a reader cannot tell a row that does not
   * APPLY to them from one that failed to load — so the honest render of
   * inapplicable is nothing, and this beats the `failed` shell below on purpose.
   */
  if (me && me.employeeId === null) return null;

  const payslip = me?.latestPayslip ?? null;

  // Nothing arrived, nothing is on its way, and nothing went wrong — there is
  // no claim to make, so no strip. `failed` is the case that DOES draw.
  if (!loading && !failed && !me) return null;

  const status =
    me?.todayStatus && isKnownStatus(me.todayStatus) ? me.todayStatus : null;

  return (
    <section
      aria-label="Your day"
      className="surface-panel rounded-[20px] p-4 sm:p-5"
      data-testid="my-corner-panel"
    >
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-[13px] font-bold text-text-heading">Your day</h2>
        {/*
          A failure is written down rather than left as a gap. A strip that
          quietly disappears when its own block did not arrive reads as "this
          account has nothing", which is the one thing the em dashes below must
          not be mistaken for.
        */}
        {failed && !me && (
          <p className="text-[11px] text-text-muted">
            Your own figures could not be read.
          </p>
        )}
      </div>

      {loading ? (
        <div
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
          data-testid="my-corner-skeleton"
        >
          {Array.from({ length: 4 }).map((_, i) => (
            <FactSkeleton key={i} />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Fact
            label="Today"
            href="/dashboard/my-attendance"
            icon={<Clock size={15} strokeWidth={2.2} />}
          >
            {/*
              Tone and wording both come from `attendanceFormat`, the vocabulary
              every attendance screen shares — a status tinted one way here and
              another on `/dashboard/my-attendance` is two screens disagreeing
              about the same day. An unrecognised or absent status is an em
              dash, not a neutral badge reading the raw enum.
            */}
            {status ? (
              <Badge tone={STATUS_TONE[status]}>{statusLabel(status)}</Badge>
            ) : (
              <span>—</span>
            )}
          </Fact>

          <Fact
            label="Leave balance"
            href="/dashboard/my-leaves"
            icon={<CalendarCheck size={15} strokeWidth={2.2} />}
          >
            {/*
              `formatNumber` prints the em dash for null on its own. The unit is
              appended only when there IS a figure, because "— days" claims a
              balance measured in days that simply came back empty.
            */}
            <span>{formatNumber(me?.leaveBalanceDays ?? null)}</span>
            {me?.leaveBalanceDays !== null && me?.leaveBalanceDays !== undefined && (
              <span className="font-normal text-text-muted">days</span>
            )}
          </Fact>

          <Fact
            label="Waiting on a decision"
            href="/dashboard/my-leaves"
            icon={<ClipboardList size={15} strokeWidth={2.2} />}
          >
            {/*
              The only figure here where zero is a real answer: the server counts
              the caller's own open requests in the database, so 0 means "nothing
              of yours is outstanding". It still becomes an em dash when the
              block did not arrive, which is `me` being undefined rather than the
              count being zero.
            */}
            <span>{formatNumber(me ? me.pendingOwnRequests : null)}</span>
            {me && (
              <span className="font-normal text-text-muted">
                {me.pendingOwnRequests === 1 ? 'request' : 'requests'}
              </span>
            )}
          </Fact>

          <Fact
            label="Latest payslip"
            href={payslip ? `/dashboard/my-payslips/${payslip.id}` : '/dashboard/my-payslips'}
            icon={<Wallet size={15} strokeWidth={2.2} />}
          >
            {/*
              The payslip's OWN currency, never the `currency` prop. A run paid
              in KWD carries three decimals; formatting it in the company unit
              would round 125.500 to 125.50 and print the wrong symbol beside it
              — a number the reader would fail to reconcile against the payslip
              itself. The prop is only the fallback for a strip with no payslip
              to name.
            */}
            <span className="truncate">
              {payslip ? formatCurrency(payslip.net, payslip.currency) : formatCurrency(null, currency)}
            </span>
            {payslip && (
              <span className="truncate font-normal text-text-muted">{payslip.label}</span>
            )}
          </Fact>
        </div>
      )}
    </section>
  );
}

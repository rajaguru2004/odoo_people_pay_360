import { WaNextStep, WhatsAppActionDef } from '../action.types';
import {
  asArray,
  bold,
  deepLink,
  escapeWa,
  fmtDate,
  fmtMoney,
  fmtTime,
  italic,
  kv,
  lines,
  outbound,
  rule,
  unwrapData,
} from '../../render/wa-format';
import { parseDateWord } from '../parsers/date.parser';
import { hasOpenSession, latestPunchAt } from '../../../attendances/attendance-punch.util';
import type { PreflightCtx } from '../action.types';
import {
  VERIFICATION_MODE,
  effectiveMode,
} from '../../../common/verification/verification.types';

/**
 * What this channel has to prove before attendance can be recorded.
 *
 * Only runs when the company has face-only attendance switched on. The mode
 * itself is resolved by the caller through the same ladder AttendancesService
 * uses, so this never promises something the service will then refuse.
 *
 *   OFF            — say so plainly. Better than letting the service throw
 *                    "Attendance can only be registered using face
 *                    verification." at somebody with no idea what to do next.
 *   IDENTITY_ONLY  — the linked account IS the identity check; proceed.
 *   SELFIE_IN_CHAT — ask for a photo. The channel decides how.
 *   SECURE_LINK    — hand out a one-time link that captures a live frame.
 */
async function faceOnlyPreflight(ctx: PreflightCtx): Promise<string | null> {
  const faceOnly = (await ctx.getSetting('attendance_face_only', 'false')) === 'true';
  if (!faceOnly) return null;

  switch (effectiveMode(ctx.verificationMode, ctx.geofenceRequired)) {
    case VERIFICATION_MODE.IDENTITY_ONLY:
      return null;
    case VERIFICATION_MODE.SELFIE_IN_CHAT:
    case VERIFICATION_MODE.SECURE_LINK:
      return ctx.faceProofPrompt();
    default:
      return 'Your company requires face verification for attendance, so this has to be done in the app.';
  }
}

/**
 * A typed "CHECK IN" carries no coordinates, so a geofenced branch would reject
 * it with a message about location permissions that makes no sense in a chat.
 * The channel answers with a one-time secure link whose page collects a real
 * browser GPS fix (and the camera too, when face verification is on) — never a
 * WhatsApp location attachment, which is any pin the sender cares to drop.
 */
async function checkInPreflight(ctx: PreflightCtx): Promise<string | null> {
  // Answer the question that was actually asked before asking for anything.
  // Someone already checked in wants to hear that they are, not be handed a
  // location prompt whose only possible outcome is a duplicate-check-in error.
  //
  // Session truth, not the columns: after in -> out -> in they BOTH hold a
  // value, so `checkIn && !checkOut` reads a mid-shift employee as finished.
  const today = await ctx.todayStatus();
  if (hasOpenSession(today)) {
    const since = latestPunchAt(today, 'in');
    return lines(
      bold('✅ Already checked in'),
      since ? kv('Since', fmtTime(since, ctx.timeZone)) : '',
    );
  }

  // Face before location: when both are needed the face prompt is a link that
  // collects the position too, so asking for a location first would send the
  // employee round a loop that ends at the same page.
  const faceOnly = await faceOnlyPreflight(ctx);
  if (faceOnly) return faceOnly;

  return ctx.geofenceRequired ? ctx.locationPrompt() : null;
}

/**
 * Checkout gets the SAME gate as check-in — the user-visible promise is
 * symmetric ("the same flow for the checkout as well"), and an unverified
 * checkout would make the verified check-in theatre: the punch pair is only as
 * honest as its weaker half.
 */
async function checkOutPreflight(ctx: PreflightCtx): Promise<string | null> {
  // Answer the question that was actually asked before asking for anything.
  const today = await ctx.todayStatus();
  if (today && !today.checkIn) {
    return lines(bold('You have not checked in yet'), 'There is nothing to check out from.');
  }
  // Open-session truth again: the checkOut column is set by EVERY check-out,
  // so a second check-in leaves it populated — and the naive test refused to
  // let somebody check out of the shift they were actually in.
  if (today?.checkIn && !hasOpenSession(today)) {
    const at = latestPunchAt(today, 'out');
    return lines(
      bold('👋 Already checked out'),
      at ? kv('At', fmtTime(at, ctx.timeZone)) : '',
    );
  }

  const faceOnly = await faceOnlyPreflight(ctx);
  if (faceOnly) return faceOnly;

  return ctx.geofenceRequired ? ctx.locationPrompt() : null;
}

const ALL: any[] = ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'];

/**
 * What people actually do after a punch.
 *
 * Every target is re-checked against the caller's visible catalogue before it
 * is offered, so an action switched off in settings simply stops appearing.
 */
const CHECKED_IN_NEXT: WaNextStep[] = [
  { target: 'attendance.lunch_start', label: 'Start lunch' },
  { target: 'attendance.checkout', label: 'Check out' },
];
const APPROVERS: any[] = ['ADMIN', 'HR_MANAGER', 'MANAGER'];
/** Admins administer expenses; they do not submit them. Mirrors the tool. */
const NON_ADMIN: any[] = ['HR_MANAGER', 'MANAGER', 'EMPLOYEE'];

/**
 * The expense categories offered in the chat.
 *
 * A convenience list, NOT the rule: the real ones live in the
 * `reimbursement_types` setting and a site may have changed them, so free text
 * is accepted too and the service stays the authority. Its rejection already
 * names the valid values, which beats this list quietly going stale.
 */
const DEFAULT_EXPENSE_TYPES = [
  'Travel',
  'Per Diem',
  'Training',
  'Medical',
  'Food',
  'Office Supplies',
  'Other',
];

/** HH:MM, or SKIP to leave that half of a correction alone. */
function parseClock(text: string | null): { ok: true; value: unknown } | { ok: false; error: string } {
  const t = (text ?? '').trim();
  if (/^skip$/i.test(t)) return { ok: true, value: undefined };
  const m = /^([01]?\d|2[0-3])[:.]?([0-5]\d)$/.exec(t);
  if (!m) return { ok: false, error: 'Reply with a time like 09:15, or SKIP.' };
  return { ok: true, value: `${m[1].padStart(2, '0')}:${m[2]}` };
}

const LEAVE_TYPES = [
  'ANNUAL',
  'SICK',
  'CASUAL',
  'MATERNITY',
  'PATERNITY',
  'UNPAID',
  'COMPENSATORY',
];

/**
 * The ESS action catalogue.
 *
 * Every entry maps to an existing MCP tool. Nothing here re-implements business
 * logic: the point of the channel is to be another way in, so balance checks,
 * overlap rejection, geofencing and the approval workflow all come from the
 * same services the web uses.
 */
export function essActions(): WhatsAppActionDef[] {
  return [
    // ------------------------------------------------------------ attendance
    {
      key: 'attendance.checkin',
      menuLabel: 'Check in',
      menuGroup: 'attendance',
      menuOrder: 1,
      roles: ALL,
      requiresEmployee: true,
      sensitivity: 'normal',
      keywords: ['check in', 'checkin', 'in', 'ci', 'punch in'],
      patterns: [/^check[\s-]?in$/, /^punch[\s-]?in$/],
      tool: { name: 'attendance_check_in' },
      preflight: checkInPreflight,
      // Nullary self-scoped write: "CHECK IN" is the act, not a request for a
      // plan, and a preview would render an empty argument list.
      confirmPolicy: 'implicit',
      nextSteps: CHECKED_IN_NEXT,
      render: (payload, ctx) => {
        const d = unwrapData(payload);
        // The LATEST session, not `attendance.checkIn` — that column holds the
        // FIRST check-in of the day and never moves, so a second check-in
        // reported the morning's time.
        const at = latestPunchAt(payload, 'in');
        return outbound(
          lines(
            bold('✅ Checked in'),
            at ? kv('Time', fmtTime(at, ctx.timeZone)) : '',
            d?.status ? kv('Status', d.status) : '',
            d?.isLate ? italic('Marked late.') : '',
          ),
        );
      },
    },
    {
      key: 'attendance.checkout',
      menuLabel: 'Check out',
      menuGroup: 'attendance',
      menuOrder: 2,
      roles: ALL,
      requiresEmployee: true,
      sensitivity: 'normal',
      keywords: ['check out', 'checkout', 'out', 'co', 'punch out'],
      patterns: [/^check[\s-]?out$/, /^punch[\s-]?out$/],
      tool: { name: 'attendance_check_out' },
      preflight: checkOutPreflight,
      confirmPolicy: 'implicit',
      nextSteps: [{ target: 'attendance.today', label: "Today's summary" }],
      render: (payload, ctx) => {
        const d = unwrapData(payload);
        const at = latestPunchAt(payload, 'out');
        return outbound(
          lines(
            bold('👋 Checked out'),
            at ? kv('Time', fmtTime(at, ctx.timeZone)) : '',
            d?.workHours !== undefined ? kv('Hours worked', d.workHours) : '',
            d?.overtimeHours ? kv('Overtime', d.overtimeHours) : '',
          ),
        );
      },
    },
    {
      key: 'attendance.today',
      menuLabel: "Today's attendance",
      menuGroup: 'attendance',
      menuOrder: 3,
      roles: ALL,
      requiresEmployee: true,
      sensitivity: 'normal',
      keywords: ['today', 'status', 'attendance', 'my attendance'],
      patterns: [/^today('s)?( attendance)?$/, /^attendance status$/],
      tool: { name: 'attendance_today_status' },
      confirmPolicy: 'none',
      // The useful follow-up is whichever punch comes next, so it depends on
      // what the tool just reported rather than on a fixed list.
      nextSteps: (payload) => {
        const d = unwrapData(payload);
        if (d?.checkIn && !d?.checkOut) {
          return [
            { target: 'attendance.checkout', label: 'Check out' },
            { target: 'attendance.lunch_start', label: 'Start lunch' },
          ];
        }
        if (!d?.checkIn) return [{ target: 'attendance.checkin', label: 'Check in' }];
        return [{ target: 'calendar.my', label: 'My schedule' }];
      },
      render: (payload, ctx) => {
        const d = unwrapData(payload);
        if (!d || (!d.checkIn && !d.status)) {
          return outbound(lines(bold("📅 Today"), 'You have not checked in yet.'));
        }
        return outbound(
          lines(
            bold('📅 Today'),
            d.status ? kv('Status', d.status) : '',
            d.checkIn ? kv('Checked in', fmtTime(d.checkIn, ctx.timeZone)) : '',
            d.checkOut ? kv('Checked out', fmtTime(d.checkOut, ctx.timeZone)) : italic('Not checked out yet.'),
            d.workHours !== undefined && d.workHours !== null ? kv('Hours', d.workHours) : '',
          ),
        );
      },
    },
    {
      key: 'attendance.lunch_start',
      menuLabel: 'Start lunch break',
      menuGroup: 'attendance',
      menuOrder: 4,
      roles: ALL,
      requiresEmployee: true,
      sensitivity: 'normal',
      keywords: ['lunch', 'lunch start', 'start lunch', 'break'],
      patterns: [/^(start )?lunch( break)?$/],
      tool: { name: 'attendance_lunch_start' },
      preflight: faceOnlyPreflight,
      confirmPolicy: 'implicit',
      nextSteps: [{ target: 'attendance.lunch_end', label: 'Back from lunch' }],
      render: () => outbound(bold('🍽️ Lunch break started')),
    },
    {
      key: 'attendance.lunch_end',
      menuLabel: 'End lunch break',
      menuGroup: 'attendance',
      menuOrder: 5,
      roles: ALL,
      requiresEmployee: true,
      sensitivity: 'normal',
      keywords: ['lunch end', 'end lunch', 'back', 'resume'],
      patterns: [/^(end|finish) lunch( break)?$/, /^back$/],
      tool: { name: 'attendance_lunch_end' },
      preflight: faceOnlyPreflight,
      confirmPolicy: 'implicit',
      nextSteps: [{ target: 'attendance.checkout', label: 'Check out' }],
      render: () => outbound(bold('💼 Lunch break ended')),
    },

    // ----------------------------------------------------------------- leave
    {
      key: 'leave.balance',
      menuLabel: 'Leave balance',
      menuGroup: 'leave',
      menuOrder: 1,
      roles: ALL,
      requiresEmployee: true,
      sensitivity: 'normal',
      keywords: ['leave balance', 'balance', 'leaves left', 'holidays left'],
      patterns: [/^leave balance$/, /^balance$/],
      tool: { name: 'leave_balance_get' },
      confirmPolicy: 'none',
      nextSteps: [
        { target: 'leave.apply', label: 'Apply for leave' },
        { target: 'leave.my', label: 'My requests' },
      ],
      render: (payload, ctx) => {
        const d = unwrapData(payload);
        const rows = Array.isArray(d?.balances) ? d.balances : asArray(d);
        if (!rows.length) return outbound('No leave balance is recorded for you yet.');
        return outbound(
          lines(
            bold('🏖️ Leave balance'),
            ...rows.map((b: any) =>
              kv(
                b.leaveType ?? b.type ?? 'Leave',
                `${b.remaining ?? b.available ?? 0} of ${b.entitled ?? b.total ?? 0} days left`,
              ),
            ),
          ),
        );
      },
    },
    {
      key: 'leave.my',
      menuLabel: 'My leave requests',
      menuGroup: 'leave',
      menuOrder: 2,
      roles: ALL,
      requiresEmployee: true,
      sensitivity: 'normal',
      keywords: ['my leave', 'my leaves', 'leave requests', 'leave history'],
      patterns: [/^my leaves?( requests?)?$/],
      tool: { name: 'leave_my_requests' },
      confirmPolicy: 'none',
      nextSteps: [
        { target: 'leave.apply', label: 'Apply for leave' },
        { target: 'leave.balance', label: 'My balance' },
      ],
      render: (payload, ctx) => {
        const rows = asArray(payload).slice(0, 8);
        if (!rows.length) return outbound('You have no leave requests.');
        return outbound(
          lines(
            bold('📄 Your leave requests'),
            ...rows.map(
              (r: any) =>
                `• ${escapeWa(r.leaveType)} ${fmtDate(r.startDate, ctx.timeZone)}→${fmtDate(r.endDate, ctx.timeZone)} — ${escapeWa(r.status)}`,
            ),
          ),
        );
      },
    },
    {
      key: 'leave.apply',
      menuLabel: 'Apply for leave',
      menuGroup: 'leave',
      menuOrder: 3,
      roles: ALL,
      requiresEmployee: true,
      sensitivity: 'normal',
      keywords: ['apply leave', 'request leave', 'take leave', 'book leave'],
      patterns: [/^(apply|request|book) (for )?leave$/],
      tool: { name: 'leave_request_create' },
      confirmPolicy: 'explicit',
      flow: {
        key: 'leave.apply',
        ttlMinutes: 15,
        steps: [
          {
            slot: 'leaveType',
            prompt: () =>
              outbound(
                lines(
                  bold('What kind of leave?'),
                  ...LEAVE_TYPES.map((t, i) => `${bold(String(i + 1))}. ${t}`),
                ),
              ),
            parse: (input) => {
              const raw = (input.text ?? '').trim().toUpperCase();
              const n = Number(raw);
              if (Number.isInteger(n) && n >= 1 && n <= LEAVE_TYPES.length) {
                return { ok: true, value: LEAVE_TYPES[n - 1] };
              }
              const match = LEAVE_TYPES.find((t) => t === raw);
              if (match) return { ok: true, value: match };
              return { ok: false, error: 'Reply with the number of the leave type.' };
            },
          },
          {
            slot: 'startDate',
            prompt: () =>
              outbound(
                lines(
                  bold('From which date?'),
                  italic('e.g. 2026-09-01, 01/09, today or tomorrow'),
                ),
              ),
            parse: (input) => {
              const d = parseDateWord(input.text);
              return d
                ? { ok: true, value: d }
                : { ok: false, error: "I could not read that date. Try 2026-09-01." };
            },
          },
          {
            slot: 'endDate',
            prompt: () =>
              outbound(lines(bold('Until which date?'), italic('Reply "same" for a single day'))),
            parse: (input, ctx) => {
              const raw = (input.text ?? '').trim().toLowerCase();
              if (raw === 'same' || raw === 'one day' || raw === '1') {
                return { ok: true, value: ctx.slots.startDate };
              }
              const d = parseDateWord(input.text);
              if (!d) return { ok: false, error: "I could not read that date. Try 2026-09-05." };
              if (String(ctx.slots.startDate) && d < String(ctx.slots.startDate)) {
                return { ok: false, error: 'The end date cannot be before the start date.' };
              }
              return { ok: true, value: d };
            },
          },
          {
            slot: 'reason',
            prompt: () => outbound(bold('Reason for the leave?')),
            parse: (input) => {
              const raw = (input.text ?? '').trim();
              if (raw.length < 2) return { ok: false, error: 'Please give a short reason.' };
              return { ok: true, value: raw.slice(0, 1000) };
            },
          },
        ],
        buildArgs: (slots) => ({
          leaveType: slots.leaveType,
          startDate: slots.startDate,
          endDate: slots.endDate,
          reason: slots.reason,
        }),
      },
      render: (payload, ctx) => {
        const d = unwrapData(payload);
        return outbound(
          lines(
            bold('✅ Leave request submitted'),
            d?.leaveType ? kv('Type', d.leaveType) : '',
            d?.startDate ? kv('From', fmtDate(d.startDate, ctx.timeZone)) : '',
            d?.endDate ? kv('To', fmtDate(d.endDate, ctx.timeZone)) : '',
            d?.totalDays ? kv('Days', d.totalDays) : '',
            italic('You will be notified when it is reviewed.'),
          ),
        );
      },
    },

    // -------------------------------------------------------------- overtime
    {
      key: 'overtime.my',
      menuLabel: 'My overtime',
      menuGroup: 'requests',
      menuOrder: 1,
      roles: ALL,
      requiresEmployee: true,
      sensitivity: 'normal',
      keywords: ['my overtime', 'overtime', 'ot'],
      patterns: [/^(my )?overtime$/, /^ot$/],
      tool: { name: 'overtime_my_requests' },
      confirmPolicy: 'none',
      render: (payload, ctx) => {
        const rows = asArray(payload).slice(0, 8);
        if (!rows.length) return outbound('You have no overtime requests.');
        return outbound(
          lines(
            bold('⏱️ Your overtime'),
            ...rows.map(
              (r: any) => `• ${fmtDate(r.date, ctx.timeZone)} — ${escapeWa(r.hours)}h — ${escapeWa(r.status)}`,
            ),
          ),
        );
      },
    },

    // ------------------------------------------------------------------- pay
    {
      key: 'payroll.payslips',
      menuLabel: 'My payslips',
      menuGroup: 'pay',
      menuOrder: 1,
      roles: ALL,
      requiresEmployee: true,
      // Salary data: PIN step-up before anything is shown.
      sensitivity: 'sensitive',
      keywords: ['payslip', 'payslips', 'salary', 'my payslip', 'pay'],
      patterns: [/^(my )?pay ?slips?$/, /^salary$/],
      tool: { name: 'payslip_list' },
      confirmPolicy: 'none',
      // A link rather than a tap: a payslip PDF is not something this channel
      // delivers, and the full breakdown genuinely belongs in the portal.
      nextSteps: [
        {
          target: '__link.payroll',
          label: 'Full breakdown',
          url: (ctx) => deepLink(ctx.appBaseUrl, '/dashboard/my-payroll'),
        },
      ],
      render: (payload, ctx) => {
        const rows = asArray(payload).slice(0, 6);
        if (!rows.length) return outbound('No payslips are available yet.');
        return outbound(
          lines(
            bold('💰 Your payslips'),
            ...rows.map(
              (r: any) =>
                `• ${escapeWa(r.month ?? '')}/${escapeWa(r.year ?? '')} — net ${fmtMoney(
                  r.netSalary ?? r.netPay,
                  ctx.currencySymbol,
                )}`,
            ),
            '',
            `${bold('Full breakdown:')} ${deepLink(ctx.appBaseUrl, '/dashboard/my-payroll')}`,
          ),
        );
      },
    },

    // ----------------------------------------------------------------- loans
    {
      key: 'loan.my',
      menuLabel: 'My loans & advances',
      menuGroup: 'money',
      menuOrder: 1,
      roles: ALL,
      requiresEmployee: true,
      sensitivity: 'sensitive',
      keywords: ['loan', 'loans', 'advance', 'my loans'],
      patterns: [/^(my )?loans?$/, /^(my )?advances?$/],
      tool: { name: 'loan_my_requests' },
      confirmPolicy: 'none',
      render: (payload, ctx) => {
        const rows = asArray(payload).slice(0, 6);
        if (!rows.length) return outbound('You have no loans or advances.');
        return outbound(
          lines(
            bold('🏦 Your loans & advances'),
            ...rows.map(
              (r: any) =>
                `• ${escapeWa(r.type ?? 'Loan')} ${fmtMoney(r.amount, ctx.currencySymbol)} — ${escapeWa(r.status)}`,
            ),
          ),
        );
      },
    },

    // ---------------------------------------------------------------- travel
    {
      key: 'travel.my',
      menuLabel: 'My travel requests',
      menuGroup: 'requests',
      menuOrder: 1,
      roles: ALL,
      requiresEmployee: true,
      sensitivity: 'normal',
      keywords: ['travel', 'my travel', 'trips'],
      patterns: [/^(my )?travels?$/, /^trips?$/],
      tool: { name: 'travel_my_requests' },
      confirmPolicy: 'none',
      render: (payload, ctx) => {
        const rows = asArray(payload).slice(0, 6);
        if (!rows.length) return outbound('You have no travel requests.');
        return outbound(
          lines(
            bold('✈️ Your travel'),
            ...rows.map(
              (r: any) =>
                `• ${escapeWa(r.destination)} ${fmtDate(r.departureDate, ctx.timeZone)} — ${escapeWa(r.status)}`,
            ),
          ),
        );
      },
    },

    // -------------------------------------------------------------- training
    {
      key: 'training.my',
      menuLabel: 'My training',
      menuGroup: 'requests',
      menuOrder: 2,
      roles: ALL,
      requiresEmployee: true,
      sensitivity: 'normal',
      keywords: ['training', 'my training', 'courses'],
      patterns: [/^(my )?trainings?$/, /^courses?$/],
      tool: { name: 'training_my_trainings' },
      confirmPolicy: 'none',
      render: (payload, ctx) => {
        const rows = asArray(payload).slice(0, 6);
        if (!rows.length) return outbound('You have no training records.');
        return outbound(
          lines(
            bold('🎓 Your training'),
            ...rows.map(
              (r: any) =>
                `• ${escapeWa(r.session?.course?.title ?? r.courseName ?? 'Course')} — ${escapeWa(r.status)}`,
            ),
          ),
        );
      },
    },

    // ---------------------------------------------------------------- assets
    {
      key: 'asset.my',
      menuLabel: 'My company items',
      menuGroup: 'requests',
      menuOrder: 3,
      roles: ALL,
      requiresEmployee: true,
      sensitivity: 'normal',
      keywords: ['assets', 'my assets', 'equipment', 'devices'],
      patterns: [/^(my )?assets?$/, /^equipment$/],
      tool: { name: 'asset_my_assets' },
      confirmPolicy: 'none',
      render: (payload, ctx) => {
        const rows = asArray(payload).slice(0, 8);
        if (!rows.length) return outbound('You have no company items assigned.');
        return outbound(
          lines(
            bold('📦 Your company items'),
            ...rows.map(
              (r: any) =>
                `• ${escapeWa(r.asset?.name ?? r.assetName ?? 'Item')} (${escapeWa(r.asset?.assetTag ?? r.assetTag ?? '—')})`,
            ),
          ),
        );
      },
    },

    // ------------------------------------------------------------- approvals
    {
      key: 'approvals.inbox',
      menuLabel: 'Approvals waiting for me',
      menuGroup: 'approvals',
      menuOrder: 1,
      roles: APPROVERS,
      requiresEmployee: false,
      sensitivity: 'normal',
      keywords: ['approvals', 'pending', 'my approvals', 'inbox'],
      patterns: [/^approvals?$/, /^pending( approvals?)?$/],
      tool: { name: 'approval_pending_for_me' },
      confirmPolicy: 'none',
      // Approve/reject arrive as buttons on the notification itself, so the
      // useful follow-up from a list is the place you can act on all of them.
      nextSteps: [
        {
          target: '__link.approvals',
          label: 'Review in portal',
          url: (ctx) => deepLink(ctx.appBaseUrl, '/dashboard'),
        },
      ],
      render: (payload, ctx) => {
        const rows = asArray(payload).slice(0, 8);
        if (!rows.length) return outbound('Nothing is waiting for your approval.');
        return outbound(
          lines(
            bold('📝 Waiting for you'),
            ...rows.map(
              (r: any) => `• ${escapeWa(r.type ?? r.requestType ?? 'Request')} — ${escapeWa(r.requesterName ?? '')}`,
            ),
            '',
            `${bold('Review:')} ${deepLink(ctx.appBaseUrl, '/dashboard')}`,
          ),
        );
      },
    },

    // -------------------------------------------------------------- calendar
    {
      key: 'calendar.my',
      menuLabel: 'My schedule',
      menuGroup: 'attendance',
      menuOrder: 6,
      roles: ALL,
      requiresEmployee: true,
      sensitivity: 'normal',
      keywords: ['schedule', 'shift', 'shifts', 'roster', 'calendar'],
      patterns: [/^(my )?(schedule|shifts?|roster|calendar)$/],
      tool: {
        name: 'employee_calendar_get',
        // The tool requires a window and the chat has no place to ask for one,
        // so "my schedule" means the fortnight ahead. Server-derived: the
        // caller cannot influence either date.
        dynamicArgs: () => {
          const from = new Date();
          const to = new Date(from.getTime() + 14 * 86_400_000);
          const ymd = (d: Date) => d.toISOString().slice(0, 10);
          return { startDate: ymd(from), endDate: ymd(to) };
        },
      },
      confirmPolicy: 'none',
      render: (payload, ctx) => {
        const d = unwrapData(payload);
        const rows = asArray(d?.shifts ?? d).slice(0, 7);
        if (!rows.length) return outbound('No upcoming shifts are scheduled.');
        return outbound(
          lines(
            bold('🗓️ Your schedule'),
            ...rows.map(
              (s: any) => `• ${fmtDate(s.date ?? s.startTime, ctx.timeZone)} ${fmtTime(s.startTime, ctx.timeZone)}–${fmtTime(s.endTime, ctx.timeZone)}`,
            ),
          ),
        );
      },
    },

    // --------------------------------------------------------------- company
    {
      key: 'holiday.list',
      menuLabel: 'Holidays',
      menuGroup: 'company',
      menuOrder: 1,
      roles: ALL,
      requiresEmployee: false,
      sensitivity: 'normal',
      keywords: ['holidays', 'holiday', 'public holidays', 'days off'],
      patterns: [/^(public )?holidays?$/],
      tool: {
        name: 'holiday_list',
        // Server-derived: nobody types a year, and asking for one would turn a
        // one-word question into a flow.
        dynamicArgs: () => ({ year: new Date().getFullYear() }),
      },
      confirmPolicy: 'none',
      render: (payload, ctx) => {
        const today = new Date();
        const rows = asArray(payload)
          .filter((h: any) => new Date(h.date) >= new Date(today.toDateString()))
          .slice(0, 6);
        if (!rows.length) return outbound('No more holidays are scheduled this year.');
        return outbound(
          lines(
            bold('🏢 Upcoming holidays'),
            ...rows.map((h: any) => `• ${fmtDate(h.date, ctx.timeZone)} — ${escapeWa(h.name)}`),
          ),
        );
      },
      nextSteps: [{ target: 'calendar.my', label: 'My schedule' }],
    },
    {
      key: 'directory.lookup',
      menuLabel: 'Find a colleague',
      menuGroup: 'company',
      menuOrder: 2,
      roles: ALL,
      requiresEmployee: false,
      sensitivity: 'normal',
      keywords: ['directory', 'find', 'who is', 'colleague', 'contact'],
      patterns: [/^(staff )?directory$/],
      tool: { name: 'employee_directory' },
      confirmPolicy: 'none',
      flow: {
        key: 'directory.lookup',
        steps: [
          {
            slot: 'search',
            prompt: () =>
              outbound(lines(bold('🔎 Find a colleague'), 'Type a name or an employee code.')),
            parse: (input) => {
              const q = (input.text ?? '').trim();
              return q.length >= 2
                ? { ok: true, value: q }
                : { ok: false, error: 'Please type at least two characters.' };
            },
          },
        ],
        buildArgs: (slots) => ({ search: slots.search }),
      },
      render: (payload) => {
        const rows = asArray(payload).slice(0, 8);
        if (!rows.length) return outbound('Nobody matched that. Try a different spelling.');
        return outbound(
          lines(
            bold('🔎 Directory'),
            // Name, role and code only. The service also returns email, and a
            // scrapeable address list has no business in a consumer messenger.
            ...rows.map(
              (r: any) =>
                `• ${escapeWa(r.fullName)}${r.position ? ` — ${escapeWa(r.position)}` : ''}` +
                `${r.employeeCode ? ` (${escapeWa(r.employeeCode)})` : ''}`,
            ),
            rows.length === 8 ? italic('Showing the first 8. Refine your search for more.') : '',
          ),
        );
      },
    },

    // -------------------------------------------------------- reimbursements
    {
      key: 'reimbursement.my',
      menuLabel: 'My expense claims',
      menuGroup: 'money',
      menuOrder: 3,
      roles: NON_ADMIN,
      requiresEmployee: true,
      sensitivity: 'normal',
      keywords: ['expenses', 'expense', 'claims', 'reimbursement', 'reimbursements'],
      patterns: [/^(my )?(expenses?|claims?|reimbursements?)$/],
      tool: { name: 'reimbursement_my_requests' },
      confirmPolicy: 'none',
      render: (payload, ctx) => {
        const rows = asArray(payload).slice(0, 6);
        if (!rows.length) return outbound('You have no expense claims.');
        return outbound(
          lines(
            bold('🧾 Your expense claims'),
            ...rows.map(
              (r: any) =>
                `• ${escapeWa(r.type)} ${fmtMoney(r.amount, ctx.currencySymbol)} — ${escapeWa(r.status)}`,
            ),
          ),
        );
      },
      nextSteps: [{ target: 'reimbursement.submit', label: 'New claim' }],
    },
    {
      key: 'reimbursement.submit',
      menuLabel: 'Claim an expense',
      menuGroup: 'money',
      menuOrder: 4,
      roles: NON_ADMIN,
      requiresEmployee: true,
      sensitivity: 'normal',
      keywords: ['claim expense', 'new claim', 'submit expense', 'reimburse'],
      patterns: [/^(claim|submit) (an )?expense$/],
      tool: { name: 'reimbursement_create' },
      confirmPolicy: 'explicit',
      flow: {
        key: 'reimbursement.submit',
        ttlMinutes: 15,
        steps: [
          {
            slot: 'type',
            prompt: () =>
              outbound(
                lines(
                  bold('What kind of expense?'),
                  ...DEFAULT_EXPENSE_TYPES.map((t, i) => `${bold(String(i + 1))}. ${t}`),
                  '',
                  italic('Or type your own category.'),
                ),
              ),
            // The numbered list is a convenience, not the rule: the categories
            // live in the `reimbursement_types` setting and a site may have
            // changed them. Free text is therefore accepted and the SERVICE is
            // the authority — its rejection already names the valid values,
            // which is better than this list quietly going stale.
            parse: (input) => {
              const raw = (input.text ?? '').trim();
              const n = Number(raw);
              if (Number.isInteger(n) && n >= 1 && n <= DEFAULT_EXPENSE_TYPES.length) {
                return { ok: true, value: DEFAULT_EXPENSE_TYPES[n - 1] };
              }
              return raw.length >= 2
                ? { ok: true, value: raw.slice(0, 60) }
                : { ok: false, error: 'Reply with a number from the list, or type a category.' };
            },
          },
          {
            slot: 'amount',
            prompt: () =>
              outbound(lines(bold('How much?'), italic('Just the number, e.g. 1250'))),
            parse: (input) => {
              const raw = (input.text ?? '').trim();
              // Check the sign BEFORE stripping: the old cleanup removed '-'
              // along with the currency symbol, so "-5" became a ₹5 claim.
              if (/^-/.test(raw)) {
                return { ok: false, error: 'The amount has to be more than zero.' };
              }
              const n = Number(raw.replace(/[^\d.]/g, ''));
              return Number.isFinite(n) && n > 0
                ? { ok: true, value: n }
                : { ok: false, error: 'Reply with the amount as a number, e.g. 1250.' };
            },
          },
          {
            slot: 'expenseDate',
            prompt: () =>
              outbound(lines(bold('What date was it?'), italic('e.g. 2026-08-01, today, yesterday'))),
            parse: (input) => {
              const d = parseDateWord(input.text);
              return d
                ? { ok: true, value: d }
                : { ok: false, error: 'I could not read that date. Try 2026-08-01.' };
            },
          },
          {
            slot: 'description',
            prompt: () =>
              outbound(
                lines(
                  bold('What was it for?'),
                  italic('A short note. Reply SKIP to leave it blank.'),
                ),
              ),
            parse: (input) => {
              const t = (input.text ?? '').trim();
              return { ok: true, value: /^skip$/i.test(t) ? undefined : t.slice(0, 500) };
            },
          },
        ],
        buildArgs: (slots) => ({
          type: slots.type,
          amount: slots.amount,
          expenseDate: slots.expenseDate,
          ...(slots.description ? { description: slots.description } : {}),
        }),
      },
      render: (payload, ctx) => {
        const d = unwrapData(payload);
        return outbound(
          lines(
            bold('✅ Expense claim submitted'),
            d?.type ? kv('Type', d.type) : '',
            d?.amount !== undefined ? kv('Amount', fmtMoney(d.amount, ctx.currencySymbol)) : '',
            d?.expenseDate ? kv('Date', fmtDate(d.expenseDate, ctx.timeZone)) : '',
            italic('Attach a receipt in the portal if your policy needs one.'),
          ),
        );
      },
      nextSteps: [{ target: 'reimbursement.my', label: 'My claims' }],
    },

    // ------------------------------------------------------ more attendance
    {
      key: 'attendance.correction_request',
      menuLabel: 'Fix my attendance',
      menuGroup: 'attendance',
      menuOrder: 8,
      roles: ALL,
      requiresEmployee: true,
      sensitivity: 'normal',
      keywords: ['correction', 'fix attendance', 'forgot to check in', 'missed punch'],
      patterns: [/^(attendance )?correction$/, /^forgot to check ?(in|out)$/],
      tool: { name: 'attendance_correction_create' },
      confirmPolicy: 'explicit',
      flow: {
        key: 'attendance.correction_request',
        ttlMinutes: 15,
        steps: [
          {
            slot: 'date',
            prompt: () =>
              outbound(lines(bold('Which day?'), italic('e.g. 2026-08-01, yesterday'))),
            parse: (input) => {
              const d = parseDateWord(input.text);
              return d
                ? { ok: true, value: d }
                : { ok: false, error: 'I could not read that date. Try 2026-08-01.' };
            },
          },
          {
            slot: 'checkIn',
            prompt: () =>
              outbound(
                lines(bold('What time did you start?'), italic('e.g. 09:15. Reply SKIP if it was right.')),
              ),
            parse: (input) => parseClock(input.text),
          },
          {
            slot: 'checkOut',
            prompt: () =>
              outbound(
                lines(bold('And what time did you finish?'), italic('e.g. 18:00. Reply SKIP if it was right.')),
              ),
            parse: (input) => parseClock(input.text),
          },
          {
            slot: 'reason',
            prompt: () => outbound(bold('Why does it need correcting?')),
            parse: (input) => {
              const t = (input.text ?? '').trim();
              return t.length >= 3
                ? { ok: true, value: t.slice(0, 500) }
                : { ok: false, error: 'Please give a short reason.' };
            },
          },
        ],
        buildArgs: (slots) => ({
          date: slots.date,
          ...(slots.checkIn ? { requestedCheckIn: `${slots.date}T${slots.checkIn}:00` } : {}),
          ...(slots.checkOut ? { requestedCheckOut: `${slots.date}T${slots.checkOut}:00` } : {}),
          reason: slots.reason,
        }),
      },
      render: (payload, ctx) => {
        const d = unwrapData(payload);
        return outbound(
          lines(
            bold('✅ Correction requested'),
            d?.date ? kv('Date', fmtDate(d.date, ctx.timeZone)) : '',
            italic('Your manager will review it.'),
          ),
        );
      },
      nextSteps: [{ target: 'attendance.history', label: 'This month' }],
    },
    {
      key: 'attendance.history',
      menuLabel: 'This month',
      menuGroup: 'attendance',
      menuOrder: 7,
      roles: ALL,
      requiresEmployee: true,
      sensitivity: 'normal',
      keywords: ['history', 'this month', 'my month', 'attendance history'],
      patterns: [/^(my )?attendance (history|month)$/],
      tool: {
        name: 'attendance_employee_history',
        dynamicArgs: () => {
          const now = new Date();
          return { month: now.getMonth() + 1, year: now.getFullYear() };
        },
      },
      confirmPolicy: 'none',
      render: (payload) => {
        const rows = asArray(payload);
        if (!rows.length) return outbound('No attendance is recorded for you this month.');
        const present = rows.filter((r: any) => r.status === 'PRESENT').length;
        const late = rows.filter((r: any) => r.isLate).length;
        const hours = rows.reduce((n: number, r: any) => n + (Number(r.workHours) || 0), 0);
        return outbound(
          lines(
            bold('📊 This month so far'),
            kv('Days recorded', rows.length),
            kv('Present', present),
            late ? kv('Late', late) : '',
            kv('Hours', hours.toFixed(1)),
          ),
        );
      },
      nextSteps: [{ target: 'attendance.today', label: 'Today' }],
    },

    // -------------------------------------------------------------- more pay
    {
      key: 'payroll.ytd',
      menuLabel: 'This year so far',
      menuGroup: 'pay',
      menuOrder: 2,
      roles: ALL,
      requiresEmployee: true,
      // Salary data: PIN step-up before anything is shown.
      sensitivity: 'sensitive',
      keywords: ['ytd', 'year to date', 'this year', 'annual'],
      patterns: [/^(ytd|year[- ]to[- ]date)$/],
      tool: {
        name: 'payslip_ytd',
        dynamicArgs: () => ({ year: new Date().getFullYear() }),
      },
      confirmPolicy: 'none',
      render: (payload, ctx) => {
        const d = unwrapData(payload);
        if (!d) return outbound('No payroll is recorded for you this year.');
        return outbound(
          lines(
            bold('💰 This year so far'),
            d.totalEarnings !== undefined
              ? kv('Earnings', fmtMoney(d.totalEarnings, ctx.currencySymbol))
              : '',
            d.totalDeductions !== undefined
              ? kv('Deductions', fmtMoney(d.totalDeductions, ctx.currencySymbol))
              : '',
            d.totalNet !== undefined ? kv('Net paid', fmtMoney(d.totalNet, ctx.currencySymbol)) : '',
            d.monthsPaid !== undefined ? kv('Months paid', d.monthsPaid) : '',
          ),
        );
      },
      nextSteps: [{ target: 'payroll.payslips', label: 'My payslips' }],
    },

    // ------------------------------------------------------------ more money
    {
      key: 'loan.statement',
      menuLabel: 'Loan statement',
      menuGroup: 'money',
      menuOrder: 2,
      roles: ALL,
      requiresEmployee: true,
      sensitivity: 'sensitive',
      keywords: ['loan statement', 'statement', 'repayments'],
      patterns: [/^loan statement$/],
      tool: {
        name: 'loan_statement',
        // The tool requires employeeId and self-scope only covers EMPLOYEE and
        // MANAGER, so an HR user with a linked record would otherwise fail. It
        // is the CALLER'S own id either way: never anything they supplied.
        dynamicArgs: (ctx) => ({ employeeId: ctx.employeeId }),
      },
      confirmPolicy: 'none',
      render: (payload, ctx) => {
        const d = unwrapData(payload);
        const rows = asArray(d?.loans ?? d).slice(0, 4);
        if (!rows.length) return outbound('You have no loans on record.');
        return outbound(
          lines(
            bold('🏦 Your loans'),
            ...rows.map(
              (l: any) =>
                `• ${escapeWa(l.loanType ?? l.type ?? 'Loan')} — ` +
                `${fmtMoney(l.outstanding ?? l.balance, ctx.currencySymbol)} outstanding` +
                `${l.status ? ` (${escapeWa(l.status)})` : ''}`,
            ),
          ),
        );
      },
      nextSteps: [{ target: 'loan.my', label: 'My requests' }],
    },
  ];
}

export const HELP_FOOTER = lines(rule(), italic('Reply MENU for all options, or HELP for guidance.'));

/**
 * Turning a URL into something safe and countable.
 *
 * Two jobs, both pure so they can be unit-tested without a browser:
 *
 *   1. **Sanitise.** A raw ESS path carries record identifiers —
 *      `/dashboard/employees/9d2f.../payroll`. Sent as-is, GA4 would hold a
 *      per-employee page list, which is exactly the personal data this
 *      integration must not collect. Every id-shaped segment collapses to
 *      `:id`, so the report reads `/dashboard/employees/:id/payroll` and counts
 *      the SCREEN rather than the person.
 *
 *   2. **Group.** 54 route folders is too granular to answer "which modules do
 *      people use". The module map mirrors the navigation groups in
 *      components/dashboard/navConfig.ts, so a GA breakdown lines up with what
 *      the sidebar actually shows.
 */

/** Segments that are record ids rather than screen names. */
const ID_SEGMENT = new RegExp(
  [
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', // uuid
    '^c[a-z0-9]{20,}$', // cuid
    '^[0-9a-f]{24,}$', // mongo-ish / long hex
    '^\\d+$', // numeric id
    '^\\d{4}-\\d{2}(-\\d{2})?$', // a date or month used as a path segment
  ].join('|'),
  'i',
);

/** Anything with an `@` is an address; it never belongs in an analytics path. */
const EMAIL_SEGMENT = /@/;

/**
 * Collapse identifiers out of a path and drop the query string.
 *
 * Query strings are dropped wholesale rather than filtered: they carry search
 * terms, and an ESS search box is typed with employee names in it.
 */
export function sanitizePath(input: string): string {
  if (!input) return '/';
  const [pathOnly] = input.split(/[?#]/);
  const segments = pathOnly.split('/').filter(Boolean);
  if (segments.length === 0) return '/';

  const safe = segments.map((segment, index) => {
    const decoded = safeDecode(segment);
    if (EMAIL_SEGMENT.test(decoded)) return ':id';
    // The FIRST segment is always a route root — `dashboard`, `login`, `403`.
    // Masking it turned the permission-denied page into `/:id` in module
    // `other`, because `403` is numeric. No record id is ever mounted there.
    if (index > 0 && ID_SEGMENT.test(decoded)) return ':id';
    return decoded.toLowerCase();
  });

  return `/${safe.join('/')}`;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    // Malformed escape — the raw segment is still safe to pattern-match.
    return segment;
  }
}

/**
 * Module a `/dashboard/<segment>` route belongs to.
 *
 * Keys are the route folder names under app/dashboard; values are the nav
 * groups from navConfig.ts. Self-service ("my-*") screens are one module of
 * their own because the question "how much of the portal is ESS self-service
 * vs. HR administration" is the first one anybody asks of this data.
 */
const MODULE_BY_SEGMENT: Record<string, string> = {
  // Organization
  branches: 'organization',
  departments: 'organization',
  organization: 'organization',
  // People
  employees: 'people',
  contracts: 'people',
  'supervisor-teams': 'people',
  teams: 'people',
  'visa-reports': 'people',
  people: 'people',
  // Time & attendance
  attendance: 'attendance',
  'face-recognition': 'attendance',
  timesheets: 'attendance',
  'work-logs': 'attendance',
  time: 'attendance',
  schedules: 'schedules',
  // Leave & overtime
  leaves: 'leave',
  overtime: 'leave',
  leave: 'leave',
  // Payroll
  payroll: 'payroll',
  banks: 'payroll',
  garnishments: 'payroll',
  // Finance
  reimbursements: 'finance',
  travel: 'finance',
  'advance-loans': 'finance',
  budgets: 'finance',
  accounting: 'finance',
  finance: 'finance',
  // Talent
  appraisal: 'talent',
  training: 'talent',
  rewards: 'talent',
  disciplines: 'talent',
  'rewards-disciplines': 'talent',
  grievances: 'talent',
  talent: 'talent',
  // Workplace
  assets: 'workplace',
  letters: 'workplace',
  projects: 'workplace',
  workplace: 'workplace',
  // Cross-cutting
  approvals: 'approvals',
  'my-team': 'my_team',
  'my-department': 'my_team',
  copilot: 'copilot',
  settings: 'system',
  'audit-logs': 'system',
  notifications: 'system',
  system: 'system',
};

/** Module for a sanitised path. Never throws; unknown routes report `other`. */
export function moduleForPath(sanitized: string): string {
  const segments = sanitized.split('/').filter(Boolean);

  if (segments.length === 0) return 'landing';

  if (segments[0] !== 'dashboard') {
    if (segments[0] === 'login') return 'auth';
    if (segments[0] === 'checkin') return 'attendance';
    if (segments[0] === 'verify') return 'verification';
    if (segments[0] === '403') return 'system';
    return 'other';
  }

  // `/dashboard` itself is the home dashboard, not a module.
  if (segments.length === 1) return 'dashboard';

  const key = segments[1];
  // Every `my-*` screen is self-service, except the two that are really team
  // views and are mapped explicitly above.
  if (MODULE_BY_SEGMENT[key]) return MODULE_BY_SEGMENT[key];
  if (key.startsWith('my-') || key === 'profile') return 'self_service';
  return 'other';
}

export interface ScreenDescriptor {
  /** Sanitised path — safe to use as GA4's `page_path`. */
  path: string;
  /** Nav-group bucket, e.g. `payroll`. */
  module: string;
  /** Stable screen key, e.g. `dashboard.payroll.:id.wps`. */
  screen: string;
}

/** Everything a page_view needs, derived from a raw pathname. */
export function describeScreen(pathname: string): ScreenDescriptor {
  const path = sanitizePath(pathname);
  const screen = path === '/' ? 'root' : path.slice(1).split('/').join('.');
  return { path, module: moduleForPath(path), screen };
}

/**
 * Named journeys, keyed off the API call the screen makes.
 *
 * The generic mutation tracker (see events.ts) already records every write with
 * its sanitised endpoint, so this table is NOT required for coverage — it only
 * gives the handful of journeys product actually asks about a readable name in
 * GA4 instead of `POST /leave-requests`.
 *
 * To add a journey: one row here. No screen component has to change.
 */
const NAMED_ACTIONS: Array<{ method: string; path: RegExp; action: string }> = [
  { method: 'POST', path: /^\/attendances\/check-in$/, action: 'attendance_check_in' },
  { method: 'POST', path: /^\/attendances\/check-out$/, action: 'attendance_check_out' },
  { method: 'POST', path: /^\/attendances\/lunch-check-(in|out)$/, action: 'attendance_lunch_punch' },
  { method: 'POST', path: /^\/face-recognition\/(capture-)?(lunch-)?check-(in|out)$/, action: 'attendance_face_punch' },
  { method: 'POST', path: /^\/attendance-corrections$/, action: 'attendance_correction_submitted' },
  { method: 'POST', path: /^\/attendance-corrections\/:id\/(approve|reject)$/, action: 'attendance_correction_decided' },
  { method: 'POST', path: /^\/leave-requests$/, action: 'leave_request_submitted' },
  { method: 'POST', path: /^\/leave-requests\/:id\/(approve|reject)$/, action: 'leave_request_decided' },
  { method: 'POST', path: /^\/overtime(\/employee\/:id)?$/, action: 'overtime_request_submitted' },
  { method: 'POST', path: /^\/overtime\/:id\/(approve|reject)$/, action: 'overtime_request_decided' },
  { method: 'POST', path: /^\/payrolls$/, action: 'payroll_run_created' },
  { method: 'POST', path: /^\/payrolls\/:id\/(finalize|submit|lock)$/, action: 'payroll_run_advanced' },
  { method: 'POST', path: /^\/payrolls\/:id\/(approve|reject)$/, action: 'payroll_run_decided' },
  { method: 'POST', path: /^\/employees$/, action: 'employee_created' },
  { method: 'POST', path: /^\/employees\/import\/confirm$/, action: 'employee_import_confirmed' },
  { method: 'POST', path: /^\/reimbursements$/, action: 'reimbursement_submitted' },
  { method: 'POST', path: /^\/advance-loans$/, action: 'advance_loan_requested' },
  { method: 'POST', path: /^\/travel-requests$/, action: 'travel_request_submitted' },
  { method: 'POST', path: /^\/grievances$/, action: 'grievance_submitted' },
];

/** Friendly journey name for a mutation, or `null` to fall back to the generic event. */
export function namedActionFor(method: string, sanitizedEndpoint: string): string | null {
  const upper = method.toUpperCase();
  const match = NAMED_ACTIONS.find((entry) => entry.method === upper && entry.path.test(sanitizedEndpoint));
  return match ? match.action : null;
}

/**
 * Module a backend endpoint belongs to, so API activity slices the same way
 * screens do. Endpoint roots do not always equal route folders (`/leave-requests`
 * vs `/dashboard/leaves`), hence the separate prefix list.
 */
const MODULE_BY_ENDPOINT: Array<[RegExp, string]> = [
  [/^\/(attendances|attendance-corrections|face-recognition|timesheets|work-logs)\b/, 'attendance'],
  [/^\/(leave-requests|leave-balances|leave-types|overtime)\b/, 'leave'],
  [/^\/(payrolls|payroll|salary|banks|garnishments|wps)\b/, 'payroll'],
  [/^\/(reimbursements|travel-requests|advance-loans|budgets|accounting)\b/, 'finance'],
  [/^\/(employees|contracts|termination|supervisor|teams|visa)\b/, 'people'],
  [/^\/(departments|branches|organization)\b/, 'organization'],
  [/^\/(appraisals?|training|rewards|disciplines|grievances)\b/, 'talent'],
  [/^\/(assets|letters|projects|tasks|sprints)\b/, 'workplace'],
  [/^\/(approval-workflows|approvals)\b/, 'approvals'],
  [/^\/(system-settings|audit|notifications|dev-mode)\b/, 'system'],
  [/^\/auth\b/, 'auth'],
];

/** Module for a sanitised endpoint. Unknown endpoints report `other`. */
export function moduleForEndpoint(sanitizedEndpoint: string): string {
  const hit = MODULE_BY_ENDPOINT.find(([pattern]) => pattern.test(sanitizedEndpoint));
  return hit ? hit[1] : 'other';
}

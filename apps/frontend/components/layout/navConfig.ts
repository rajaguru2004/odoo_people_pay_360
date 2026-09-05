import {
  Award,
  Boxes,
  Building2,
  CalendarRange,
  ClipboardCheck,
  Clock,
  FolderOpen,
  LayoutDashboard,
  Palmtree,
  Settings,
  Users,
  Wallet,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { UserRole } from '@/types/auth';
import type { PublicBranding } from '@/types/settings';

/**
 * The navigation tree, and the rules that decide who sees which part of it.
 *
 * It lives here rather than inside Sidebar because it has two consumers: the
 * rail, and every module landing page — a hub renders its own children as tiles.
 * If the hub re-derived that list it would drift, and a route the rail hides for
 * a role would still be offered as a tile that then lands on /403. One builder,
 * one answer.
 */

export interface NavChild {
  /** Stable key: the React key, the `sidebar` message key, and the tile icon key. */
  labelKey: string;
  href: string;
  /**
   * Narrows a child below its parent. Omit to inherit the parent's audience.
   *
   * A group usually mixes audiences — People is visible to a payroll officer,
   * but "Add employee" inside it is ADMIN/HR only, and drawing the link would
   * just hand them a screen the server refuses.
   */
  roles?: UserRole[];
}

export interface NavGroup {
  icon: LucideIcon;
  /** Also the module key: what a landing page passes to look itself up. */
  labelKey: string;
  href: string;
  /**
   * The URL prefix this group OWNS, when that is not where its header points.
   * Defaults to `href`.
   *
   * Organisation is the case it exists for: its hub is `/dashboard/organization`
   * but the screens it owns live under `/dashboard/departments` and
   * `/dashboard/branches`, so the children carry the matching and the group
   * needs no prefix of its own. A group whose hub sits BESIDE the routes it owns
   * declares `basePath` so those routes still resolve to it.
   */
  basePath?: string;
  roles: UserRole[];
  /**
   * Who may open the HUB itself, when that is narrower than who may see the
   * group. Omit when the two are the same.
   *
   * A module hub aggregates governance figures — headless departments, the
   * change-request queue, span of control — and its endpoint is gated tighter
   * than the list screens underneath it. A payroll officer is entitled to the
   * employee directory and the branch list but not to that aggregate, so the
   * group must still appear for them with its header pointing at the first
   * screen they CAN open. Without this the rail offers a route the server
   * refuses, and the user is bounced to /403 by their own sidebar.
   */
  hubRoles?: UserRole[];
  /**
   * The UI-affordance gate, mirroring `utils/permissions.ts`. It decides what to
   * draw; the backend's RolesGuard decides what is allowed, and a hidden entry
   * must never be the only thing stopping an action.
   */
  permissions?: string[];
  children?: NavChild[];
}

/**
 * Admin, HR and payroll navigation, grouped by module rather than by screen.
 *
 * A group's `href` is its module hub — the page the header row links to, which
 * repeats these same children as tiles. Every child href is a real route in this
 * app; nothing here points at a screen nobody has built.
 *
 * `roles` on a group states who the group is for, and `roles` on a child narrows
 * it further. Both are enforced by `buildMenu`, so a role named nowhere in an
 * entry never sees it — which is what keeps the rail and the tiles honest about
 * the same set of screens.
 */
export const adminMenuItems: NavGroup[] = [
  {
    icon: LayoutDashboard,
    labelKey: 'dashboard',
    href: '/dashboard',
    roles: ['ADMIN', 'HR_MANAGER', 'PAYROLL_OFFICER'],
    permissions: ['VIEW_DASHBOARD'],
  },
  {
    icon: Building2,
    labelKey: 'organization',
    href: '/dashboard/organization',
    roles: ['ADMIN', 'HR_MANAGER', 'PAYROLL_OFFICER'],
    // GET /organization/hub-summary is ADMIN + HR only.
    hubRoles: ['ADMIN', 'HR_MANAGER'],
    permissions: ['VIEW_DEPARTMENTS'],
    children: [
      { labelKey: 'branches', href: '/dashboard/branches' },
      { labelKey: 'allDepartments', href: '/dashboard/departments' },
      { labelKey: 'organizationalChart', href: '/dashboard/departments/tree' },
      // The queue where a move between departments is approved, which is an
      // administrative act rather than a reading of the structure.
      {
        labelKey: 'changeRequests',
        href: '/dashboard/departments/change-requests',
        roles: ['ADMIN', 'HR_MANAGER'],
      },
    ],
  },
  {
    icon: Users,
    labelKey: 'people',
    href: '/dashboard/people',
    roles: ['ADMIN', 'HR_MANAGER', 'PAYROLL_OFFICER'],
    // GET /employees/hub-summary is ADMIN + HR only.
    hubRoles: ['ADMIN', 'HR_MANAGER'],
    permissions: ['VIEW_EMPLOYEES'],
    children: [
      { labelKey: 'employeeDirectory', href: '/dashboard/employees' },
      { labelKey: 'addEmployee', href: '/dashboard/employees/new', roles: ['ADMIN', 'HR_MANAGER'] },
      { labelKey: 'teams', href: '/dashboard/teams' },
      // A contract carries the salary terms a payroll run reads, so the list is
      // open to a payroll officer; creating and ending one is not.
      { labelKey: 'allContracts', href: '/dashboard/contracts' },
      { labelKey: 'newContract', href: '/dashboard/contracts/new', roles: ['ADMIN', 'HR_MANAGER'] },
      {
        labelKey: 'terminations',
        href: '/dashboard/contracts/terminations',
        roles: ['ADMIN', 'HR_MANAGER'],
      },
      { labelKey: 'visaReports', href: '/dashboard/visa-reports', roles: ['ADMIN', 'HR_MANAGER'] },
    ],
  },
  {
    icon: Clock,
    labelKey: 'timeAttendance',
    href: '/dashboard/time',
    roles: ['ADMIN', 'HR_MANAGER', 'PAYROLL_OFFICER'],
    permissions: ['VIEW_EMPLOYEES'],
    children: [
      { labelKey: 'attendanceOverview', href: '/dashboard/attendance' },
      {
        labelKey: 'attendanceRequests',
        href: '/dashboard/attendance/corrections',
        roles: ['ADMIN', 'HR_MANAGER'],
      },
      { labelKey: 'attendanceLogs', href: '/dashboard/attendance/history' },
      { labelKey: 'attendanceReports', href: '/dashboard/attendance/reports' },
      {
        labelKey: 'attendanceManager',
        href: '/dashboard/attendance/management',
        roles: ['ADMIN', 'HR_MANAGER'],
      },
      {
        labelKey: 'biometricEnrollment',
        href: '/dashboard/attendance/face-management',
        roles: ['ADMIN', 'HR_MANAGER'],
      },
    ],
  },
  {
    // Separate from Time & attendance on purpose. That module is a RECORD of
    // what happened; this one is the PLAN for what is meant to. They share the
    // WorkSchedule table and nothing else, and folding the roster into the
    // attendance rail would bury "nobody is covering Thursday" under six screens
    // about last month.
    icon: CalendarRange,
    labelKey: 'schedules',
    href: '/dashboard/schedules',
    roles: ['ADMIN', 'HR_MANAGER'],
    permissions: ['VIEW_SCHEDULES'],
    children: [
      { labelKey: 'workingSchedule', href: '/dashboard/schedules/overview' },
      { labelKey: 'shiftCalendar', href: '/dashboard/schedules/calendar' },
      {
        labelKey: 'shiftManagement',
        href: '/dashboard/schedules/shifts',
        roles: ['ADMIN', 'HR_MANAGER'],
      },
    ],
  },
  {
    // Leave and overtime sit in ONE module because they are the same trade:
    // hours the company owes against hours it has bought. Splitting them would
    // put "who is away" and "who worked late" on two rails, and the person
    // planning next week needs both answers at once.
    //
    // The hub lives at /dashboard/leave while the screens it owns are under
    // /dashboard/leaves and /dashboard/overtime, so `basePath` keeps the group
    // owning its own prefix while the children claim theirs.
    icon: Palmtree,
    labelKey: 'leaveOvertime',
    href: '/dashboard/leave',
    basePath: '/dashboard/leave',
    roles: ['ADMIN', 'HR_MANAGER', 'PAYROLL_OFFICER'],
    // GET /leave-requests/hub-summary is ADMIN, HR and MANAGER: it answers by
    // name and by reason, and a sick note is not a payroll fact.
    hubRoles: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
    permissions: ['VIEW_LEAVE', 'VIEW_OVERTIME'],
    children: [
      {
        labelKey: 'leaveRequests',
        href: '/dashboard/leaves',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
      },
      {
        labelKey: 'pendingLeave',
        href: '/dashboard/leaves/pending',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
      },
      {
        labelKey: 'leaveBalances',
        href: '/dashboard/leaves/balances',
        roles: ['ADMIN', 'HR_MANAGER'],
      },
      { labelKey: 'leaveTypes', href: '/dashboard/leave/types', roles: ['ADMIN', 'HR_MANAGER'] },
      {
        labelKey: 'leaveAllocations',
        href: '/dashboard/leave/allocations',
        roles: ['ADMIN', 'HR_MANAGER'],
      },
      // Overtime IS a payroll fact, which is why a payroll officer reads these
      // two and none of the leave screens above.
      { labelKey: 'overtimeRequests', href: '/dashboard/overtime' },
      {
        labelKey: 'overtimePolicies',
        href: '/dashboard/overtime/policies',
        roles: ['ADMIN', 'HR_MANAGER'],
      },
    ],
  },
  {
    icon: Wallet,
    labelKey: 'payroll',
    href: '/dashboard/payroll',
    roles: ['ADMIN', 'HR_MANAGER', 'PAYROLL_OFFICER'],
    // GET /payroll/hub-summary is ADMIN + HR + payroll officer — the same three
    // the group is for, so no re-pointing is needed here. The manager and
    // employee trees are the ones that need it, and they carry it below.
    hubRoles: ['ADMIN', 'HR_MANAGER', 'PAYROLL_OFFICER'],
    permissions: ['VIEW_ALL_PAYROLL'],
    children: [
      { labelKey: 'payrollRuns', href: '/dashboard/payroll/runs' },
      // Starting a run is MANAGE_PAYROLL. An HR manager reads payroll and does
      // not run it, and POST /payroll-runs refuses them.
      {
        labelKey: 'runPayroll',
        href: '/dashboard/payroll/runs/new',
        roles: ['ADMIN', 'PAYROLL_OFFICER'],
      },
      { labelKey: 'payslips', href: '/dashboard/payroll/payslips' },
      { labelKey: 'salaryStructures', href: '/dashboard/payroll/structures' },
      { labelKey: 'salaryComponents', href: '/dashboard/payroll/salary-components' },
      { labelKey: 'payrollReports', href: '/dashboard/payroll/reports' },
    ],
  },
  {
    icon: Award,
    labelKey: 'talent',
    href: '/dashboard/training',
    roles: ['ADMIN', 'HR_MANAGER'],
    permissions: ['VIEW_EMPLOYEES'],
    children: [
      { labelKey: 'training', href: '/dashboard/training' },
      { labelKey: 'grievances', href: '/dashboard/grievances' },
    ],
  },
  {
    icon: Boxes,
    labelKey: 'workplace',
    href: '/dashboard/assets',
    roles: ['ADMIN', 'HR_MANAGER'],
    permissions: ['VIEW_EMPLOYEES'],
    children: [
      { labelKey: 'assets', href: '/dashboard/assets' },
      { labelKey: 'letters', href: '/dashboard/letters' },
    ],
  },
  {
    icon: Settings,
    labelKey: 'system',
    // The group and its only child point at the same screen, which is what the
    // tie-break in `findGroupForPathname` is for: the trail reads
    // "System › Settings" rather than stopping at the section.
    href: '/dashboard/settings',
    roles: ['ADMIN'],
    permissions: ['VIEW_SYSTEM_SETTINGS'],
    children: [{ labelKey: 'settings', href: '/dashboard/settings' }],
  },
];

/**
 * Department head.
 *
 * The same three modules, narrowed to what a manager may do with them: read the
 * structure, read the people in it, and work their team's attendance. Everything
 * that changes a record company-wide — hiring, ending a contract, enrolling a
 * face — stays with ADMIN and HR, because that is where the server puts it too.
 */
export const departmentHeadMenuItems: NavGroup[] = [
  {
    icon: LayoutDashboard,
    labelKey: 'dashboard',
    href: '/dashboard',
    roles: ['MANAGER'],
    permissions: ['VIEW_DASHBOARD'],
  },
  {
    icon: Building2,
    labelKey: 'organization',
    href: '/dashboard/organization',
    roles: ['MANAGER'],
    hubRoles: ['ADMIN', 'HR_MANAGER'],
    permissions: ['VIEW_DEPARTMENTS'],
    children: [
      { labelKey: 'branches', href: '/dashboard/branches' },
      { labelKey: 'allDepartments', href: '/dashboard/departments' },
      { labelKey: 'organizationalChart', href: '/dashboard/departments/tree' },
    ],
  },
  {
    icon: Users,
    labelKey: 'people',
    href: '/dashboard/people',
    roles: ['MANAGER'],
    hubRoles: ['ADMIN', 'HR_MANAGER'],
    permissions: ['VIEW_EMPLOYEES'],
    children: [
      { labelKey: 'employeeDirectory', href: '/dashboard/employees' },
      { labelKey: 'teams', href: '/dashboard/teams' },
    ],
  },
  {
    icon: Clock,
    labelKey: 'timeAttendance',
    href: '/dashboard/time',
    roles: ['MANAGER'],
    permissions: ['VIEW_EMPLOYEES'],
    children: [
      { labelKey: 'attendanceOverview', href: '/dashboard/attendance' },
      { labelKey: 'attendanceRequests', href: '/dashboard/attendance/corrections' },
      { labelKey: 'attendanceLogs', href: '/dashboard/attendance/history' },
      { labelKey: 'attendanceReports', href: '/dashboard/attendance/reports' },
    ],
  },
  {
    icon: CalendarRange,
    labelKey: 'schedules',
    href: '/dashboard/schedules',
    roles: ['MANAGER'],
    permissions: ['VIEW_SCHEDULES'],
    // A department head reads their team's roster and cannot write it: every
    // route under /work-schedules is ADMIN + HR server-side, so offering the
    // management screen here would hand them a page whose every button 403s.
    children: [
      { labelKey: 'workingSchedule', href: '/dashboard/schedules/overview' },
      { labelKey: 'shiftCalendar', href: '/dashboard/schedules/calendar' },
    ],
  },
  {
    icon: Palmtree,
    labelKey: 'leaveOvertime',
    href: '/dashboard/leave',
    basePath: '/dashboard/leave',
    roles: ['MANAGER'],
    permissions: ['VIEW_LEAVE'],
    // A department head decides their team's requests and reads their balances;
    // the library and the allocation runs stay with HR, because those change
    // what the whole company is entitled to.
    children: [
      { labelKey: 'leaveRequests', href: '/dashboard/leaves' },
      { labelKey: 'pendingLeave', href: '/dashboard/leaves/pending' },
      { labelKey: 'overtimeRequests', href: '/dashboard/overtime' },
    ],
  },
  {
    // Pointed at self-service, NOT at the hub. A manager holds only
    // VIEW_OWN_PAYSLIP, and GET /payroll/hub-summary refuses them — left
    // pointing at /dashboard/payroll this entry would bounce them to /403 by
    // way of their own sidebar, the defect docs/MIGRATION.md §8 records.
    icon: Wallet,
    labelKey: 'myPayslips',
    href: '/dashboard/my-payslips',
    roles: ['MANAGER'],
    permissions: ['VIEW_OWN_PAYSLIP'],
  },
];

/**
 * Employee self-service.
 *
 * An employee's nav is their own record, so the groups are cut by what the
 * record is ABOUT — their time, their pay, their file — rather than by which
 * server module answers. None of them is a hub: the module dashboards
 * aggregate company-wide figures the server does not serve to this role, so a
 * group header points straight at the first screen underneath it.
 *
 * Approvals and My team stay TOP-LEVEL entries rather than children of a
 * group. Both are visible only to somebody who actually has a queue or a
 * report, and that decision is made against the entry's own `href` — demoting
 * either to a child moves it out of reach of the check and shows it to
 * everybody.
 */
export const employeeMenuItems: NavGroup[] = [
  {
    icon: LayoutDashboard,
    labelKey: 'dashboard',
    href: '/dashboard',
    roles: ['EMPLOYEE'],
    permissions: ['VIEW_DASHBOARD'],
  },
  {
    icon: ClipboardCheck,
    labelKey: 'approvals',
    href: '/dashboard/approvals',
    roles: ['EMPLOYEE'],
    permissions: ['VIEW_DASHBOARD'],
  },
  {
    icon: Users,
    labelKey: 'myTeam',
    href: '/dashboard/my-team',
    roles: ['EMPLOYEE'],
    permissions: ['VIEW_DASHBOARD'],
  },
  {
    // My Leave and My Overtime stay top-level entries below rather than being
    // repeated in here: one rail entry per destination, or the active-state
    // highlight lands on two rows at once.
    icon: Clock,
    labelKey: 'myTime',
    href: '/dashboard/my-attendance',
    roles: ['EMPLOYEE'],
    permissions: ['VIEW_OWN_PROFILE'],
    children: [
      { labelKey: 'myAttendance', href: '/dashboard/my-attendance' },
      { labelKey: 'attendanceRequests', href: '/dashboard/attendance/corrections' },
      { labelKey: 'biometricVerification', href: '/dashboard/face-recognition' },
      { labelKey: 'myCalendar', href: '/dashboard/my-calendar' },
    ],
  },
  {
    // Flat, and pointed at the SELF screens. The company-wide lists answer by
    // name across the workforce and the server refuses them to this role, so a
    // rail entry for one would be a link straight to /403.
    icon: Palmtree,
    labelKey: 'myLeave',
    href: '/dashboard/my-leaves',
    roles: ['EMPLOYEE'],
    permissions: ['VIEW_OWN_LEAVE'],
  },
  {
    icon: Clock,
    labelKey: 'myOvertime',
    href: '/dashboard/my-overtime',
    roles: ['EMPLOYEE'],
    permissions: ['VIEW_OWN_OVERTIME'],
  },
  {
    // Self-service, for the same reason the manager entry is: the hub is a
    // workforce-wide aggregate this role is refused.
    icon: Wallet,
    labelKey: 'myPayslips',
    href: '/dashboard/my-payslips',
    roles: ['EMPLOYEE'],
    permissions: ['VIEW_OWN_PAYSLIP'],
  },
  {
    icon: FolderOpen,
    labelKey: 'myRecords',
    href: '/dashboard/my-documents',
    roles: ['EMPLOYEE'],
    permissions: ['VIEW_OWN_PROFILE'],
    children: [
      { labelKey: 'myDocuments', href: '/dashboard/my-documents' },
      { labelKey: 'myLetters', href: '/dashboard/my-letters' },
      { labelKey: 'myAssets', href: '/dashboard/my-assets' },
      { labelKey: 'myTraining', href: '/dashboard/my-training' },
      { labelKey: 'myGrievances', href: '/dashboard/my-grievances' },
    ],
  },
  {
    icon: Settings,
    labelKey: 'settings',
    href: '/dashboard/settings',
    roles: ['EMPLOYEE'],
    permissions: ['VIEW_OWN_PROFILE'],
  },
];

/**
 * The menu a role actually gets: the right tree, role-filtered, empty groups
 * pruned.
 *
 * Pure, and the only place visibility is decided. `branding` is threaded through
 * because both consumers build from the same pair of inputs — role and company
 * settings — so a rule that varies by company cannot be applied in the rail and
 * forgotten in the tiles. Nothing in the current tree varies by company; the
 * role decides all of it.
 */
export function buildMenu(
  role: UserRole | undefined | null,
  branding?: PublicBranding | null,
): NavGroup[] {
  // No role, no menu. The session is still being restored, and a rail built for
  // "whoever this turns out to be" is a rail that shows the wrong person's
  // routes for a frame.
  if (!role) return [];

  const source =
    role === 'EMPLOYEE'
      ? employeeMenuItems
      : role === 'MANAGER'
        ? departmentHeadMenuItems
        : adminMenuItems;

  return filterMenuForRole(source, role);
}

/** The role filter itself, over any tree — `buildMenu` is this plus the tree. */
export function filterMenuForRole(menu: NavGroup[], role: UserRole): NavGroup[] {
  return (
    menu
      .filter((group) => group.roles.includes(role))
      .map((group) => {
        if (!group.children?.length) return group;
        // A child may narrow its parent's audience; no `roles` = inherit it.
        const children = group.children.filter(
          (child) => !child.roles || child.roles.includes(role),
        );
        // A role that may see the group but not open its hub gets a header
        // pointing at the first screen it is actually allowed to reach.
        // `basePath` keeps the group owning its URL prefix, so breadcrumbs and
        // the active-section highlight are unaffected by the re-point.
        const canOpenHub = !group.hubRoles || group.hubRoles.includes(role);
        if (canOpenHub || !children.length) return { ...group, children };
        return {
          ...group,
          href: children[0].href,
          basePath: group.basePath ?? group.href,
          children,
        };
      })
      // A group whose children all filtered away is an empty accordion: it opens
      // onto nothing while its header still promises a section. Better no entry.
      .filter((group) => !group.children || group.children.length > 0)
  );
}

/** The group a landing page is the hub for. `moduleKey` is the group's labelKey. */
export function findGroupByModuleKey(menu: NavGroup[], moduleKey: string): NavGroup | undefined {
  return menu.find((group) => group.labelKey === moduleKey);
}

/**
 * Which group owns a pathname, and which of its children — the raw material for
 * a breadcrumb trail derived from the route rather than declared page by page.
 *
 * The LONGEST matching href wins, which is the whole point:
 * `/dashboard/departments/tree` is a prefix match for both "All departments"
 * (`/dashboard/departments`) and "Organisational chart", and only the longer one
 * names the screen the reader is actually on.
 *
 * A child wins an exact tie against its own group, so a group that points at one
 * of its own children resolves to the child — naming the screen is more use than
 * stopping at the section.
 *
 * A group matches on `basePath` as well as `href`, scored the same way by
 * length, so a group whose hub sits beside the routes it owns still claims them
 * while a longer child href keeps winning.
 */
export function findGroupForPathname(
  menu: NavGroup[],
  pathname: string,
): { group: NavGroup; child?: NavChild } | undefined {
  let best: { group: NavGroup; child?: NavChild; score: number } | undefined;

  const owns = (prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

  for (const group of menu) {
    // `basePath` defaults to `href`, so a group declaring neither is unchanged
    // and a group declaring both can match on either.
    for (const prefix of new Set([group.href, group.basePath ?? group.href])) {
      if (!owns(prefix)) continue;
      if (!best || prefix.length > best.score) best = { group, score: prefix.length };
    }
    for (const child of group.children ?? []) {
      if (!owns(child.href)) continue;
      // `>=` rather than `>`: on an exact tie the child is the later, more
      // specific answer.
      if (!best || child.href.length >= best.score) {
        best = { group, child, score: child.href.length };
      }
    }
  }

  if (!best) return undefined;
  // The dashboard entry's href is a prefix of every route in the shell, so a
  // screen the nav does not list matches it and nothing else. That is not
  // ownership — it is the absence of a location — and answering with it would
  // light Dashboard on a page it does not own.
  if (!best.child && best.group.href === '/dashboard' && pathname !== '/dashboard') {
    return undefined;
  }
  return { group: best.group, child: best.child };
}

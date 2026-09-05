import {
  Boxes,
  Banknote,
  LayoutDashboard,
  Users,
  Clock,
  Calendar,
  CalendarDays,
  FileText,
  Settings,
  Building2,
  FolderKanban,
  Sparkles,
  Award,
  Inbox,
  UserCheck,
} from 'lucide-react';
import type { BrandingData } from '@/store/brandingStore';

/**
 * The navigation tree, and the rules that decide who sees which part of it.
 *
 * This lives outside Sidebar.tsx because it now has two consumers. A module
 * landing page renders the same children as tiles, and if it re-derived that
 * list it would drift: a route hidden by a feature flag in the rail would still
 * be offered as a tile, and the tile would hand the user a 403. One builder,
 * one answer.
 */

export interface NavChild {
  labelKey: string;
  href: string;
  /**
   * Narrows a child below its parent. Omit to inherit the parent's audience.
   *
   * Needed because a group can mix audiences — a department head sees the
   * group, but an ADMIN-only screen inside it would just hand them a 403 modal.
   */
  roles?: string[];
}

export interface NavGroup {
  icon: any;
  /** Also the module key: what a landing page passes to look itself up. */
  labelKey: string;
  href?: string;
  /**
   * The URL prefix this module OWNS, when that is not the same as where its
   * header points. Defaults to `href`.
   *
   * Payroll is the case it exists for: its header points at
   * `/dashboard/payroll/manage`, a SIBLING of the routes it owns, because
   * `/dashboard/payroll` itself is the payslip screen every role reaches from
   * the user menu. Matching on `href` alone therefore resolved neither
   * `/dashboard/payroll/:id` nor `/dashboard/payroll` to this module, and those
   * screens rendered no breadcrumb trail at all.
   */
  basePath?: string;
  roles: string[];
  children?: NavChild[];
}

/** Kept as the old name too — Sidebar's props and tests speak in these terms. */
export type MenuItem = NavGroup;
export type SubMenuItem = NavChild;

/**
 * Routes that only exist when their feature is on.
 *
 * Read as `!== true` rather than `=== false`, unlike the older overtime switch:
 * that is an established feature that ships ON, so it hides only when explicitly
 * disabled. These ship OFF, so a missing key — an older backend, a failed
 * request — must hide them rather than surface a screen whose API answers 404.
 */
export const FLAG_ROUTES: Array<{ flag: keyof BrandingData; hrefs: string[] }> = [
  {
    flag: 'document_engine_enabled',
    hrefs: ['/dashboard/settings/documents'],
  },
];

/**
 * Admin / HR navigation, grouped by HR module rather than by screen.
 *
 * A group's `href` is its **module landing dashboard** — the hub the header row
 * links to, which then repeats these children as tiles. Every child href is
 * unchanged from the flat version; only the group targets moved, and every old
 * group target is still reachable because it is also one of the children.
 *
 * Two things must stay TOP-LEVEL: `approvals` and `my-team`. Their visibility
 * gates match on `item.href` in the Sidebar filter, so demoting either to a
 * child would silently stop the gate firing.
 *
 * Child `roles` is used sparingly. This array serves ADMIN *and* HR_MANAGER, and
 * most `roles: ['ADMIN']` labels on the old flat items were decorative — never
 * enforced — so enforcing them now would newly hide working pages from HR. Only
 * Audit Logs is genuinely ADMIN-only server-side.
 */
export const adminMenuItems: NavGroup[] = [
  { icon: LayoutDashboard, labelKey: 'dashboard', href: '/dashboard', roles: ['ADMIN', 'MANAGER'] },
  { icon: Sparkles, labelKey: 'copilot', href: '/dashboard/copilot', roles: ['ADMIN', 'HR_MANAGER'] },
  // Shown only when the user is an approver in an active chain (see canApprove).
  // ADMIN is excluded there — admins override from the domain screens instead.
  { icon: Inbox, labelKey: 'approvals', href: '/dashboard/approvals', roles: ['HR_MANAGER'] },
  {
    icon: Building2,
    labelKey: 'organization',
    href: '/dashboard/organization',
    roles: ['ADMIN', 'MANAGER'],
    children: [
      { labelKey: 'branches', href: '/dashboard/branches' },
      { labelKey: 'allDepartments', href: '/dashboard/departments' },
      { labelKey: 'organizationalChart', href: '/dashboard/departments/tree' },
      { labelKey: 'changeRequests', href: '/dashboard/departments/change-requests' },
    ],
  },
  {
    icon: Users,
    labelKey: 'people',
    href: '/dashboard/people',
    roles: ['ADMIN', 'MANAGER'],
    children: [
      { labelKey: 'employeeDirectory', href: '/dashboard/employees' },
      { labelKey: 'addEmployee', href: '/dashboard/employees/new' },
      { labelKey: 'teams', href: '/dashboard/supervisor-teams' },
      { labelKey: 'allContracts', href: '/dashboard/contracts' },
      { labelKey: 'newContract', href: '/dashboard/contracts/new' },
      { labelKey: 'terminations', href: '/dashboard/contracts/terminations' },
      { labelKey: 'visaReports', href: '/dashboard/visa-reports' },
    ],
  },
  {
    icon: Clock,
    labelKey: 'timeAttendance',
    href: '/dashboard/time',
    roles: ['ADMIN', 'MANAGER'],
    children: [
      { labelKey: 'attendanceOverview', href: '/dashboard/attendance' },
      { labelKey: 'attendanceRequests', href: '/dashboard/attendance/corrections' },
      { labelKey: 'attendanceLogs', href: '/dashboard/attendance/history' },
      { labelKey: 'attendanceReports', href: '/dashboard/attendance/reports' },
      { labelKey: 'attendanceManager', href: '/dashboard/attendance/management' },
      { labelKey: 'biometricEnrollment', href: '/dashboard/attendance/face-management' },
    ],
  },
  {
    icon: CalendarDays,
    labelKey: 'schedules',
    href: '/dashboard/schedules',
    // ADMIN + HR_MANAGER, matching VIEW_ALL_SCHEDULES and the backend's
    // @Roles on /calendar/*. This array is not read by the filter below (only
    // `child.roles` is), so the previous `['ADMIN', 'MANAGER']` changed
    // nothing — but it stated the opposite of the truth twice over: a MANAGER
    // is sent to /403 by both screens, and HR, who may use them, was not named.
    roles: ['ADMIN', 'HR_MANAGER'],
    children: [
      { labelKey: 'scheduleCalendar', href: '/dashboard/schedules/overview' },
      { labelKey: 'shiftManagement', href: '/dashboard/schedules/shifts' },
    ],
  },
  {
    icon: Calendar,
    labelKey: 'leaveOvertime',
    href: '/dashboard/leave',
    roles: ['ADMIN', 'MANAGER'],
    children: [
      { labelKey: 'leaveRequests', href: '/dashboard/leaves' },
      { labelKey: 'pendingLeaves', href: '/dashboard/leaves/pending' },
      { labelKey: 'leaveBalances', href: '/dashboard/leaves/balances' },
      { labelKey: 'overtimeRequests', href: '/dashboard/overtime' },
      { labelKey: 'logOvertime', href: '/dashboard/overtime/new' },
    ],
  },
  {
    icon: Banknote,
    labelKey: 'payroll',
    // Not `/dashboard/payroll` — that URL is the payslip screen every role
    // reaches from the user menu, and an admin hub rendered there would take it
    // away from them. The hub is a sibling under the same prefix instead.
    href: '/dashboard/payroll/manage',
    // The header points at a sibling of the routes this module owns, so the
    // prefix has to be stated separately or the record screens under
    // /dashboard/payroll/ resolve to no module and lose their trail entirely.
    basePath: '/dashboard/payroll',
    roles: ['ADMIN', 'MANAGER'],
    // Only `child.roles` is read by the filter — the group's own `roles` above is
    // inert (see the note at the top of this file). So anything narrower than
    // "everyone this menu is built for" has to be declared per child, or the
    // role is offered a screen its ProtectedRoute then bounces to /403.
    children: [
      { labelKey: 'runPayroll', href: '/dashboard/payroll/manage' },
      { labelKey: 'payrollBatches', href: '/dashboard/payroll/batches' },
      { labelKey: 'payrollApprovals', href: '/dashboard/payroll/approvals' },
      { labelKey: 'salaryStructures', href: '/dashboard/payroll/salary-structure' },
      // Narrowed because the page's ProtectedRoute asks for VIEW_ALL_PAYROLL,
      // which is ADMIN and HR_MANAGER only — the group above is built for
      // MANAGER too, and offering them a company-wide cost breakdown here would
      // hand them a /403 the moment they clicked it.
      {
        labelKey: 'payrollAnalytics',
        href: '/dashboard/payroll/analytics',
        roles: ['ADMIN', 'HR_MANAGER'],
      },
    ],
  },
  {
    icon: Award,
    labelKey: 'talent',
    href: '/dashboard/talent',
    roles: ['ADMIN', 'MANAGER'],
    children: [
      { labelKey: 'appraisals', href: '/dashboard/appraisal' },
      { labelKey: 'training', href: '/dashboard/training' },
      { labelKey: 'rewardsOverview', href: '/dashboard/rewards-disciplines' },
      { labelKey: 'reward', href: '/dashboard/rewards' },
      { labelKey: 'discipline', href: '/dashboard/disciplines' },
      { labelKey: 'grievances', href: '/dashboard/grievances' },
    ],
  },
  {
    icon: Boxes,
    labelKey: 'workplace',
    href: '/dashboard/workplace',
    roles: ['ADMIN', 'MANAGER'],
    children: [
      { labelKey: 'assets', href: '/dashboard/assets' },
      { labelKey: 'letters', href: '/dashboard/letters' },
      { labelKey: 'allProjects', href: '/dashboard/projects' },
    ],
  },
  {
    icon: Settings,
    labelKey: 'system',
    href: '/dashboard/system',
    roles: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
    children: [
      { labelKey: 'settings', href: '/dashboard/settings' },
      // Its own route rather than a settings tab: a template is a record and
      // needs a URL, and the builder needs a full-bleed canvas with save
      // semantics of its own.
      {
        labelKey: 'documentTemplates',
        href: '/dashboard/settings/documents',
        roles: ['ADMIN', 'HR_MANAGER'],
      },
      // The one genuinely ADMIN-only screen server-side.
      { labelKey: 'auditLogs', href: '/dashboard/audit-logs', roles: ['ADMIN'] },
    ],
  },
];

/**
 * Employee self-service, grouped into three areas of the employee's own record.
 * `approvals` and `my-team` stay top-level for the same gating reason as above.
 *
 * No landing hubs here: each group's href is already its primary screen, so the
 * header row navigates somewhere useful without a hub in between. Most of the
 * aggregate endpoints a hub would show are ADMIN/HR-only server-side anyway.
 */
export const employeeMenuItems: NavGroup[] = [
  { icon: LayoutDashboard, labelKey: 'dashboard', href: '/dashboard', roles: ['EMPLOYEE'] },
  { icon: Inbox, labelKey: 'approvals', href: '/dashboard/approvals', roles: ['EMPLOYEE'] },
  { icon: UserCheck, labelKey: 'myTeam', href: '/dashboard/my-team', roles: ['EMPLOYEE'] },
  {
    icon: Clock,
    labelKey: 'myTime',
    href: '/dashboard/my-attendance',
    roles: ['EMPLOYEE'],
    children: [
      { labelKey: 'myAttendance', href: '/dashboard/my-attendance' },
      { labelKey: 'attendanceRequests', href: '/dashboard/attendance/corrections' },
      { labelKey: 'biometricVerification', href: '/dashboard/face-recognition' },
      { labelKey: 'myCalendar', href: '/dashboard/my-calendar' },
      { labelKey: 'myLeaves', href: '/dashboard/my-leaves' },
      { labelKey: 'myOvertime', href: '/dashboard/my-overtime' },
    ],
  },
  {
    icon: Banknote,
    labelKey: 'myPay',
    href: '/dashboard/payroll',
    roles: ['EMPLOYEE'],
    children: [
      { labelKey: 'myPayslips', href: '/dashboard/payroll' },
    ],
  },
  {
    icon: FileText,
    labelKey: 'myRecords',
    href: '/dashboard/my-documents',
    roles: ['EMPLOYEE'],
    children: [
      { labelKey: 'myDocuments', href: '/dashboard/my-documents' },
      { labelKey: 'myLetters', href: '/dashboard/my-letters' },
      { labelKey: 'myAssets', href: '/dashboard/my-assets' },
      { labelKey: 'myTraining', href: '/dashboard/my-training' },
      { labelKey: 'myGrievances', href: '/dashboard/my-grievances' },
    ],
  },
  { icon: FolderKanban, labelKey: 'projects', href: '/dashboard/projects', roles: ['EMPLOYEE'] },
  { icon: Settings, labelKey: 'settings', href: '/dashboard/settings', roles: ['EMPLOYEE'] },
];

/**
 * Department head. The main win here is separating the manager's OWN record from
 * what they manage — the flat version put "Assets" directly beside "My Assets"
 * and "Training" beside "My Training", which read as duplicates.
 */
export const departmentHeadMenuItems: NavGroup[] = [
  { icon: LayoutDashboard, labelKey: 'dashboard', href: '/dashboard', roles: ['MANAGER'] },
  { icon: Inbox, labelKey: 'approvals', href: '/dashboard/approvals', roles: ['MANAGER'] },
  { icon: UserCheck, labelKey: 'myTeam', href: '/dashboard/my-team', roles: ['MANAGER'] },
  {
    icon: Clock,
    labelKey: 'myWorkspace',
    href: '/dashboard/my-attendance',
    roles: ['MANAGER'],
    children: [
      { labelKey: 'myAttendance', href: '/dashboard/my-attendance' },
      { labelKey: 'attendanceRequests', href: '/dashboard/attendance/corrections' },
      { labelKey: 'biometricVerification', href: '/dashboard/face-recognition' },
      { labelKey: 'myCalendar', href: '/dashboard/my-calendar' },
      { labelKey: 'myLeaves', href: '/dashboard/my-leaves' },
      { labelKey: 'myOvertime', href: '/dashboard/my-overtime' },
      { labelKey: 'myPayslips', href: '/dashboard/payroll' },
    ],
  },
  {
    icon: FileText,
    labelKey: 'myRecords',
    href: '/dashboard/my-documents',
    roles: ['MANAGER'],
    children: [
      { labelKey: 'myDocuments', href: '/dashboard/my-documents' },
      { labelKey: 'myLetters', href: '/dashboard/my-letters' },
      { labelKey: 'myAssets', href: '/dashboard/my-assets' },
      { labelKey: 'myTraining', href: '/dashboard/my-training' },
      { labelKey: 'myGrievances', href: '/dashboard/my-grievances' },
    ],
  },
  {
    icon: Users,
    labelKey: 'myDepartment',
    href: '/dashboard/my-department',
    roles: ['MANAGER'],
    children: [
      { labelKey: 'teamMembers', href: '/dashboard/my-department' },
      { labelKey: 'teamBalances', href: '/dashboard/my-department/team-balances' },
    ],
  },
  {
    icon: Calendar,
    labelKey: 'teamRequests',
    href: '/dashboard/leaves',
    roles: ['MANAGER'],
    children: [
      { labelKey: 'allLeaveRequests', href: '/dashboard/leaves' },
      { labelKey: 'pendingLeaves', href: '/dashboard/leaves/pending' },
      { labelKey: 'allOvertimeRequests', href: '/dashboard/overtime' },
    ],
  },
  {
    icon: Award,
    labelKey: 'talent',
    href: '/dashboard/training',
    roles: ['MANAGER'],
    children: [
      { labelKey: 'training', href: '/dashboard/training' },
      { labelKey: 'rewardsDisciplines', href: '/dashboard/rewards-disciplines' },
    ],
  },
  { icon: Boxes, labelKey: 'assets', href: '/dashboard/assets', roles: ['MANAGER'] },
  { icon: FolderKanban, labelKey: 'projects', href: '/dashboard/projects', roles: ['MANAGER'] },
  { icon: Settings, labelKey: 'settings', href: '/dashboard/settings', roles: ['MANAGER'] },
];

/**
 * Feature toggles hide a route wherever it appears. Checked against the href
 * rather than the item, so grouping a route under a parent does not quietly stop
 * its kill-switch working.
 */
export function hrefDisabled(href: string | undefined, branding: BrandingData | null | undefined): boolean {
  if (!href) return false;
  if (
    branding?.overtime_enabled === false &&
    (href === '/dashboard/overtime' || href === '/dashboard/my-overtime')
  ) {
    return true;
  }
  // Note the direction: overtime is an existing feature, so it hides only on an
  // explicit `false`; a flagged route hides unless explicitly `true`, because an
  // older backend that has never heard of the key must not surface a screen
  // whose API answers 404.
  for (const route of FLAG_ROUTES) {
    if (route.hrefs.includes(href) && branding?.[route.flag] !== true) {
      return true;
    }
  }
  return false;
}

/**
 * The menu a given role actually gets: role-selected, flag-filtered, with empty
 * groups pruned.
 *
 * Pure on purpose. Sidebar layers its two data-driven gates (`isSupervisor`,
 * `isApprover`) on top of this — those need fetches, and a landing page has no
 * business repeating them.
 */
export function buildMenu(role: string | undefined, branding: BrandingData | null | undefined): NavGroup[] {
  const raw =
    role === 'EMPLOYEE'
      ? employeeMenuItems
      : role === 'MANAGER'
      ? departmentHeadMenuItems
      : adminMenuItems;

  return raw
    .map((item) => {
      if (!item.children?.length) return item;
      const children = item.children.filter(
        (child) =>
          !hrefDisabled(child.href, branding) &&
          // A child may narrow its parent's audience; no `roles` = inherit.
          (!child.roles || child.roles.includes(role ?? '')),
      );
      // A group header points at its landing hub. If that href is itself
      // flag-disabled, re-point to the first surviving child — otherwise the
      // header links to a disabled route.
      const href =
        item.href && hrefDisabled(item.href, branding) ? children[0]?.href : item.href;
      return { ...item, href, children };
    })
    .filter((item) => {
      if (hrefDisabled(item.href, branding) && !item.children?.length) return false;
      // A group whose children all filtered away is an empty accordion.
      if (item.children && item.children.length === 0) return false;
      return true;
    });
}

/** The group a landing page is the hub for. `moduleKey` is the group's labelKey. */
export function findGroupByModuleKey(menu: NavGroup[], moduleKey: string): NavGroup | undefined {
  return menu.find((item) => item.labelKey === moduleKey);
}

/**
 * Which group owns a pathname, and which child of it — the raw material for a
 * breadcrumb trail derived from the route rather than declared by the page.
 *
 * Longest matching href wins, so `/dashboard/departments/tree` resolves to
 * Organizational Chart and not to the shorter All Departments prefix it also
 * starts with. A child wins an exact tie against its own group — several groups
 * point at their first child (every self-service group does), and naming the
 * screen is more use than stopping at the section.
 *
 * A group matches on its `basePath` as well as its `href`, scored the same way
 * by length. That is what lets a module whose header points beside the routes it
 * owns (Payroll) still claim them, while a longer child href keeps winning: on
 * `/dashboard/payroll/batches` the 26-char child beats the 18-char basePath.
 */
export function findGroupForPathname(
  menu: NavGroup[],
  pathname: string,
): { group: NavGroup; child?: NavChild } | undefined {
  let best: { group: NavGroup; child?: NavChild; score: number } | undefined;

  const owns = (prefix: string | undefined): prefix is string =>
    Boolean(prefix) && (pathname === prefix || pathname.startsWith(`${prefix}/`));

  for (const group of menu) {
    // `basePath` defaults to `href`, so a group declaring neither is unchanged
    // and a group declaring both can match on either.
    for (const prefix of new Set([group.href, group.basePath ?? group.href])) {
      if (!owns(prefix)) continue;
      const score = prefix.length;
      if (!best || score > best.score) best = { group, score };
    }
    for (const child of group.children ?? []) {
      if (pathname === child.href || pathname.startsWith(`${child.href}/`)) {
        const score = child.href.length;
        if (!best || score >= best.score) best = { group, child, score };
      }
    }
  }

  if (!best) return undefined;
  return { group: best.group, child: best.child };
}

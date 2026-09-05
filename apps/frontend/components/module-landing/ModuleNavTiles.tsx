'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import { useTranslations } from 'next-intl';
import {
  Building2, Network, GitPullRequestArrow, Users, UserPlus, UsersRound, FileText, FilePlus2,
  UserMinus, IdCard, Clock, ClipboardCheck, History, BarChart3, SlidersHorizontal, ScanFace,
  CalendarDays, CalendarClock, CalendarRange, CalendarCheck2, Hourglass, TimerReset, Scale,
  Banknote, PlayCircle, ShieldCheck, Layers, CheckCheck, Coins, Medal, LogOut, Gift, Undo2,
  ArrowLeftRight, FileSpreadsheet, Landmark, Settings2, Globe2, DatabaseZap, Receipt, Plane,
  HandCoins, PieChart, Wallet, Award, GraduationCap, Trophy, ThumbsUp, ThumbsDown, MessageSquareWarning,
  Boxes, Mail, Settings, ScrollText, ChevronRight,
} from 'lucide-react';
import { useModuleNav } from '@/hooks/useModuleNav';

/**
 * A face per destination.
 *
 * The nav tree carries one icon per group, not per child, and a tile grid where
 * every tile wears the same glyph is a wall of text with decoration. Keyed by
 * the child's stable `labelKey`; anything unmapped falls back to the group icon,
 * so a new nav entry degrades quietly instead of crashing.
 */
const CHILD_ICONS: Record<string, any> = {
  // Organization
  branches: Building2, allDepartments: Network, organizationalChart: Network,
  changeRequests: GitPullRequestArrow,
  // People
  employeeDirectory: Users, addEmployee: UserPlus, teams: UsersRound, allContracts: FileText,
  newContract: FilePlus2, terminations: UserMinus, visaReports: IdCard,
  // Time & attendance
  attendanceOverview: Clock, attendanceRequests: ClipboardCheck, attendanceLogs: History,
  attendanceReports: BarChart3, attendanceManager: SlidersHorizontal, biometricEnrollment: ScanFace,
  // Schedules
  scheduleCalendar: CalendarDays, shiftManagement: CalendarClock,
  // Leave & overtime
  leaveRequests: CalendarRange, pendingLeaves: CalendarCheck2, leaveBalances: Scale,
  overtimeRequests: Hourglass, logOvertime: TimerReset,
  // Payroll
  runPayroll: PlayCircle, payrollValidate: ShieldCheck, payrollBatches: Layers,
  payrollApprovals: CheckCheck, salaryStructures: Coins, payrollGrades: Medal,
  finalSettlements: LogOut, gratuityRules: Gift, leaveEncashment: Banknote,
  payrollRecoveries: Undo2, payrollCalendar: CalendarDays, payrollTransfers: ArrowLeftRight,
  payrollReports: FileSpreadsheet, bankMaster: Landmark, bankFieldConfig: Settings2,
  bankBranchCountries: Globe2, bankMigration: DatabaseZap,
  // Finance
  reimbursements: Receipt, travel: Plane, advancesLoans: HandCoins, loanReports: PieChart,
  budgets: Wallet,
  // Talent
  appraisals: Award, training: GraduationCap, rewardsOverview: Trophy, reward: ThumbsUp,
  discipline: ThumbsDown, grievances: MessageSquareWarning,
  // Workplace
  assets: Boxes, letters: Mail,
  // System
  settings: Settings, auditLogs: ScrollText,
};

export interface ModuleNavTilesProps {
  /** The nav group's labelKey. */
  moduleKey: string;
  /**
   * Live counts keyed by child labelKey — "7 waiting" beside Pending Leaves.
   * Omit a key to show no badge; 0 is shown as nothing rather than a zero pill,
   * because an empty queue is not news.
   */
  badges?: Record<string, number | undefined>;
  /** Tone override per child, for badges that mean trouble rather than volume. */
  badgeTones?: Record<string, 'default' | 'warning' | 'danger'>;
}

/**
 * The module's own children, rendered as the page's navigation.
 *
 * Fed from the same `buildMenu` output as the sidebar, so a route hidden by a
 * feature flag or a child `roles` narrowing is absent here too — a tile can
 * never hand the user a screen `ProtectedRoute` then refuses.
 */
export default function ModuleNavTiles({ moduleKey, badges, badgeTones }: ModuleNavTilesProps) {
  const group = useModuleNav(moduleKey);
  const t = useTranslations('sidebar');
  const tm = useTranslations('moduleLanding');

  if (!group?.children?.length) return null;

  return (
    <div className="grid gap-3.5 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
      {group.children.map((child, i) => {
        const Icon = CHILD_ICONS[child.labelKey] ?? group.icon;
        const count = badges?.[child.labelKey];
        const tone = badgeTones?.[child.labelKey] ?? 'default';
        const descKey = `desc.${child.labelKey}`;
        const description = tm.has(descKey) ? tm(descKey) : null;

        return (
          <motion.div
            key={child.href}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, delay: 0.02 * i }}
          >
            <Link
              href={child.href}
              className="surface-panel group flex items-start gap-3.5 h-full p-4 rounded-[20px] bg-surface-card border border-surface-border transition-all duration-200"
            >
              <span className="shrink-0 grid place-items-center w-10 h-10 rounded-xl bg-brand-primary/10 text-brand-primary group-hover:bg-brand-primary group-hover:text-text-on-brand transition-all shadow-2xs">
                <Icon size={18} strokeWidth={2.2} />
              </span>

              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="text-[13px] font-bold text-text-heading group-hover:text-brand-primary transition-colors truncate">
                    {t(child.labelKey)}
                  </span>
                  {typeof count === 'number' && count > 0 && (
                    <span
                      className={[
                        'shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-full',
                        tone === 'danger'
                          ? 'bg-status-error-bg text-status-error'
                          : tone === 'warning'
                          ? 'bg-status-warning-bg text-status-warning'
                          : 'bg-brand-primary/10 text-brand-primary',
                      ].join(' ')}
                    >
                      {count > 99 ? '99+' : count}
                    </span>
                  )}
                </span>
                {description && (
                  <span className="block mt-1 text-[11px] leading-snug text-text-muted line-clamp-2">
                    {description}
                  </span>
                )}
              </span>

              <ChevronRight
                size={16}
                className="shrink-0 mt-2 text-text-muted opacity-0 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all rtl:rotate-180"
              />
            </Link>
          </motion.div>
        );
      })}
    </div>
  );
}

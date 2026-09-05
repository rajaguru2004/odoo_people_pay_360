'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import { useTranslations } from 'next-intl';
import {
  BarChart3,
  Building2,
  ChevronRight,
  ClipboardCheck,
  Clock,
  FilePlus2,
  FileText,
  GitBranch,
  GitPullRequestArrow,
  History,
  IdCard,
  Network,
  ScanFace,
  Settings,
  SlidersHorizontal,
  UserMinus,
  UserPlus,
  Users,
  UsersRound,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useModuleNav } from '@/hooks/useModuleNav';

/**
 * A face per destination.
 *
 * The nav tree carries one icon per GROUP, and a tile grid where every tile
 * wears the same glyph is a wall of text with decoration. Keyed by the child's
 * stable `labelKey`; anything unmapped falls back to the group icon, so adding a
 * nav entry degrades quietly instead of crashing the hub.
 */
const CHILD_ICONS: Record<string, LucideIcon> = {
  // Organisation
  branches: Building2,
  allDepartments: Network,
  organizationalChart: GitBranch,
  changeRequests: GitPullRequestArrow,
  // People
  employeeDirectory: Users,
  addEmployee: UserPlus,
  teams: UsersRound,
  allContracts: FileText,
  newContract: FilePlus2,
  terminations: UserMinus,
  visaReports: IdCard,
  // Time & attendance
  attendanceOverview: Clock,
  attendanceRequests: ClipboardCheck,
  attendanceLogs: History,
  attendanceReports: BarChart3,
  attendanceManager: SlidersHorizontal,
  biometricEnrollment: ScanFace,
  // System
  settings: Settings,
};

export interface ModuleNavTilesProps {
  /** The nav group's labelKey. */
  moduleKey: string;
  /**
   * Live counts keyed by child labelKey — "7 waiting" beside Correction
   * requests. Omit a key for no badge; a count of 0 draws nothing rather than a
   * zero pill, because an empty queue is not news.
   */
  badges?: Record<string, number | undefined>;
  /** Tone override per child, for counts that mean trouble rather than volume. */
  badgeTones?: Record<string, 'default' | 'warning' | 'danger'>;
}

const BADGE_TONES = {
  default: 'bg-brand-primary/10 text-brand-primary',
  warning: 'bg-status-warning-bg text-status-warning',
  danger: 'bg-status-error-bg text-status-error',
} as const;

/**
 * The module's own children, rendered as the hub's navigation.
 *
 * Fed from the same `buildMenu` output as the sidebar, so a route this role
 * cannot open is absent here too — a tile can never hand the reader a screen
 * `ProtectedRoute` then refuses.
 */
export default function ModuleNavTiles({ moduleKey, badges, badgeTones }: ModuleNavTilesProps) {
  const group = useModuleNav(moduleKey);
  const t = useTranslations('sidebar');
  const tm = useTranslations('moduleLanding');

  if (!group?.children?.length) return null;

  return (
    <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-3">
      {group.children.map((child, i) => {
        const Icon = CHILD_ICONS[child.labelKey] ?? group.icon;
        const count = badges?.[child.labelKey];
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
              data-testid="module-tile"
              className="surface-panel group flex h-full items-start gap-3.5 rounded-[20px] p-4 transition-all duration-200"
            >
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-primary/10 text-brand-primary shadow-2xs transition-all group-hover:bg-brand-primary group-hover:text-text-on-brand">
                <Icon size={18} strokeWidth={2.2} aria-hidden />
              </span>

              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-bold text-text-heading transition-colors group-hover:text-brand-primary">
                    {t(child.labelKey)}
                  </span>
                  {typeof count === 'number' && count > 0 && (
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                        BADGE_TONES[badgeTones?.[child.labelKey] ?? 'default']
                      }`}
                    >
                      {/* Past a hundred the exact figure stops being readable at
                          this size and the queue is "large" either way. */}
                      {count > 99 ? '99+' : count}
                    </span>
                  )}
                </span>
                {description && (
                  <span className="mt-1 line-clamp-2 block text-[11px] leading-snug text-text-muted">
                    {description}
                  </span>
                )}
              </span>

              <ChevronRight
                size={16}
                aria-hidden
                className="mt-2 shrink-0 text-text-muted opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100 rtl:rotate-180"
              />
            </Link>
          </motion.div>
        );
      })}
    </div>
  );
}

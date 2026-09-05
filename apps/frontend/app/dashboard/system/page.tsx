'use client';

import { useTranslations } from 'next-intl';
import { Activity, Trash2, BellDot, ScrollText } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import ModuleLandingPage from '@/components/module-landing/ModuleLandingPage';
import type { KpiStat } from '@/components/module-landing/StatCard';
import { MeterList, PanelHeader, PanelLink, type MeterRow } from '@/components/module-landing/primitives';
import { useSystemHub } from '@/hooks/useSimpleHubs';

/**
 * System module hub.
 *
 * Configuration and the record of who changed it. The figures come from
 * `/audit-logs/stats`, which aggregates a real 24-hour window in the database —
 * they were counted in the browser over one page of the log until Phase B,
 * which meant a busy day silently under-reported.
 */
function SystemHubContent() {
  const t = useTranslations('systemHub');
  const tm = useTranslations('moduleLanding');
  const {
    stats,
    topActors,
    last24h,
    destructive24h,
    unread,
    loading,
    auditFailed,
    auditRestricted,
    notificationsFailed,
  } = useSystemHub();

  // "Not allowed to know" and "tried and could not find out" are different
  // sentences. Both print an em dash, and the panel below says which one it is
  // — an unexplained blank card is what makes a working screen look broken.
  const auditUnknown = auditFailed || auditRestricted;

  const kpis: KpiStat[] = [
    {
      key: 'activity',
      label: t('kpiActivity'),
      value: auditUnknown || !Number.isFinite(last24h) ? null : last24h,
      icon: Activity,
      footnote: t('kpiActivityHint'),
      href: '/dashboard/audit-logs',
    },
    {
      key: 'destructive',
      label: t('kpiDestructive'),
      value: auditUnknown || !Number.isFinite(destructive24h) ? null : destructive24h,
      icon: Trash2,
      tone: destructive24h > 0 ? 'warning' : 'success',
      footnote: t('kpiDestructiveHint'),
      href: '/dashboard/audit-logs',
    },
    {
      key: 'unread',
      label: t('kpiUnread'),
      value: notificationsFailed || !Number.isFinite(unread) ? null : unread,
      icon: BellDot,
      footnote: t('kpiUnreadHint'),
      href: '/dashboard/notifications',
    },
    {
      key: 'resources',
      label: t('kpiBusiestResource'),
      value: auditUnknown || !stats?.byResource?.length ? null : stats.byResource[0].resource,
      icon: ScrollText,
      footnote: stats?.byResource?.length
        ? t('kpiBusiestResourceHint', { count: stats.byResource[0].count })
        : undefined,
      href: '/dashboard/audit-logs',
    },
  ];

  const busiest = topActors[0]?.count ?? 1;
  const meters: MeterRow[] = topActors.map((a, i) => ({
    key: a.name,
    label: a.name,
    percent: (a.count / busiest) * 100,
    valueLabel: t('events', { count: a.count }),
    color: `color-mix(in srgb, var(--color-brand-primary) ${Math.max(100 - i * 14, 45)}%, white)`,
  }));

  return (
    <ModuleLandingPage
      moduleKey="system"
      title={tm('system.title')}
      subtitle={tm('system.subtitle')}
      kpis={kpis}
      kpisLoading={loading}
      insights={
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="surface-panel p-5 flex flex-col">
            <PanelHeader
              title={t('busiestActors')}
              hint={t('busiestActorsHint')}
              action={<PanelLink href="/dashboard/audit-logs">{t('seeAuditLogs')}</PanelLink>}
            />
            {auditRestricted ? (
              <p className="text-[13px] text-text-muted">{t('auditAdminOnly')}</p>
            ) : meters.length === 0 ? (
              <p className="text-[13px] text-text-muted">
                {auditFailed ? t('auditUnknown') : t('noActivity')}
              </p>
            ) : (
              <div className="flex-1 flex flex-col justify-center">
                <MeterList rows={meters} />
              </div>
            )}
          </div>

          <div className="surface-panel p-5 flex flex-col">
            <PanelHeader title={t('countedHere')} />
            <p className="text-[13px] text-text-body leading-relaxed">
              {auditRestricted ? t('auditAdminOnlyBody') : t('countedHereBody')}
            </p>
          </div>
        </div>
      }
    />
  );
}

export default function SystemHubPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER']}>
      <SystemHubContent />
    </ProtectedRoute>
  );
}

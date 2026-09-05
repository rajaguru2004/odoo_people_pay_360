'use client';

import React, { useEffect, useState, memo } from 'react';
import { Users, Clock, FileText, AlertTriangle, Activity, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import axiosInstance from '@/lib/axios';
import { useAuthStore } from '@/store/authStore';
import { getBusinessTZ } from '@/utils/tzDate';
import { StatCard, KpiStat } from '@/components/module-landing/StatCard';

interface SnapshotData {
  workingNow: number;
  lateToday: number;
  pendingApprovals: number;
  expiringContracts: number;
  lastUpdated: string;
}

/**
 * The tiles are the module-landing `StatCard` — the same card every module hub
 * uses — so the dashboard and the pages it links to are one design. `urgent` is
 * the only thing StatCard has no slot for: it is a state of THIS figure right
 * now (a late count that needs someone), not a property of the number, so it
 * stays here as a pulse badge over the card.
 */
interface SnapshotCard {
  stat: KpiStat;
  urgent?: boolean;
}

interface TodaySnapshotProps {
  date?: string;
}

const TodaySnapshot = memo(function TodaySnapshot({ date }: TodaySnapshotProps) {
  const { user } = useAuthStore();
  const t = useTranslations('todaySnapshot');
  const [data, setData] = useState<SnapshotData>({
    workingNow: 0,
    lateToday: 0,
    pendingApprovals: 0,
    expiringContracts: 0,
    lastUpdated: new Date().toISOString(),
  });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    fetchSnapshot();
    const interval = setInterval(fetchSnapshot, 30000);
    return () => clearInterval(interval);
  }, [date]);

  const fetchSnapshot = async () => {
    try {
      const response: any = await axiosInstance.get('/dashboard/today-snapshot', {
        params: { date },
      });
      if (response?.success && response?.data) {
        setData({
          workingNow: response.data.workingNow || 0,
          lateToday: response.data.lateToday || 0,
          pendingApprovals: response.data.pendingApprovals || 0,
          expiringContracts: response.data.expiringContracts || 0,
          lastUpdated: response.data.lastUpdated || new Date().toISOString(),
        });
      }
    } catch (error: any) {
      console.error('Failed to fetch snapshot:', { message: error?.message });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchSnapshot();
  };

  const formatTime = (isoString: string) => {
    const date = new Date(isoString);
    return date.toLocaleTimeString('en-IN', {
      timeZone: getBusinessTZ(),
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const isManager = user?.role === 'MANAGER';

  const cards: SnapshotCard[] = [
    {
      stat: {
        key: 'active',
        label: t('activeLabel'),
        value: data.workingNow,
        icon: Users,
        tone: 'default',
        href: '/dashboard/attendance',
        footnote: t('activeDesc'),
      },
    },
    {
      stat: {
        key: 'late',
        label: t('lateLabel'),
        value: data.lateToday,
        icon: Clock,
        tone: 'warning',
        href: '/dashboard/attendance?status=late',
        footnote: t('lateDesc'),
      },
      urgent: data.lateToday > 5,
    },
    {
      stat: {
        key: 'pending',
        label: t('pendingLabel'),
        value: data.pendingApprovals,
        icon: FileText,
        tone: 'info',
        href: '/dashboard/leaves?status=pending',
        footnote: t('pendingDesc'),
      },
      urgent: data.pendingApprovals > 10,
    },
    ...(!isManager
      ? [
          {
            stat: {
              key: 'expiring-contracts',
              label: t('expiringContractLabel'),
              value: data.expiringContracts,
              icon: AlertTriangle,
              tone: 'danger' as const,
              href: '/dashboard/employees?filter=expiring-contracts',
              footnote: t('expiringContractDesc'),
            },
            urgent: data.expiringContracts > 0,
          },
        ]
      : []),
  ];

  if (loading) {
    return (
      <div className="surface-panel p-6 h-full">
        <div className="animate-pulse space-y-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-xl bg-surface-page" />
              <div className="space-y-2">
                <div className="h-4 w-32 bg-surface-page rounded" />
                <div className="h-3 w-24 bg-surface-page rounded" />
              </div>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="h-36 bg-surface-page rounded-[20px]" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="surface-panel overflow-hidden h-full flex flex-col">
      {/* Card Header */}
      <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-surface-border-light">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-brand-primary to-brand-accent flex items-center justify-center shadow-lg shadow-brand-primary/20">
            <Activity className="text-white" size={20} strokeWidth={2} />
          </div>
          <div>
            <h3 className="text-sm font-bold text-text-heading">{t('title')}</h3>
            <p className="text-xs text-text-muted flex items-center gap-1.5 mt-0.5">
              <span className="w-1.5 h-1.5 bg-status-success rounded-full animate-pulse inline-block" />
              {t('updatedAt', { time: formatTime(data.lastUpdated) })}
            </p>
          </div>
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="p-2 hover:bg-surface-page rounded-lg transition-colors text-text-muted hover:text-brand-primary disabled:opacity-50"
          title="Refresh"
        >
          <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>

      {/*
        2×2 grid of module-landing StatCards. The recess is what keeps a card
        inside a card readable: both wear `--color-surface-card`, so on a white
        run the four tiles would dissolve into the panel and only their borders
        would survive. Sitting them on the page colour is also how a module hub
        shows the same card.
      */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-4 flex-1 bg-surface-page">
        {cards.map((card, index) => (
          <div key={card.stat.key} className="relative h-full">
            {card.urgent && (
              <span className="absolute top-3 end-3 z-10 flex h-2 w-2" aria-hidden>
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-status-error opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-status-error" />
              </span>
            )}
            <StatCard stat={card.stat} index={index} />
          </div>
        ))}
      </div>
    </div>
  );
});

export default TodaySnapshot;

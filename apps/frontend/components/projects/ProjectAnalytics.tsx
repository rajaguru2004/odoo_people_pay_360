'use client';

import React, { useEffect, useState } from 'react';
import {
  BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import projectTaskService from '@/services/projectTaskService';
import { chartColors } from '@/theme/chartColors';

export default function ProjectAnalytics({ slug }: { slug: string }) {
  const t = useTranslations('projectAnalytics');
  const te = useTranslations('projectEnums');
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = (await projectTaskService.charts(slug)) as any;
        setData(res.data);
      } finally { setLoading(false); }
    })();
  }, [slug]);

  if (loading) return <div className="flex h-48 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-brand-primary" /></div>;
  if (!data) return null;

  const kpis = [
    { key: 'total-tasks', label: t('statTotalTasks'), value: data.kpi.total },
    { key: 'done', label: te('statusCompleted'), value: data.kpi.done },
    { key: 'in-progress', label: te('categoryInProgress'), value: data.kpi.inProgress },
    { key: 'completion-rate', label: t('statCompletionRate'), value: `${data.kpi.completionRate ?? 0}%` },
  ];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {kpis.map((k) => (
          <div key={k.label} data-testid={`project-analytics-kpi-${k.key}`} className="rounded-[--radius-card] border border-surface-border bg-surface-card p-4">
            <p className="text-xs text-text-muted">{k.label}</p>
            <p className="text-2xl font-bold text-text-heading">{k.value}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <ChartCard title={t('chartTasksByStatus')}>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={data.statusDistribution}>
              <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
              <XAxis dataKey="name" tick={{ fontSize: 12, fill: chartColors.axisText }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: chartColors.axisText }} />
              <Tooltip contentStyle={{ background: chartColors.tooltipBg, border: `1px solid ${chartColors.tooltipBorder}`, borderRadius: 8 }} />
              <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                {data.statusDistribution.map((d: any, i: number) => <Cell key={i} fill={d.color || chartColors.primary} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title={t('chartTasksByPriority')}>
          <ResponsiveContainer width="100%" height={260}>
            <PieChart>
              <Pie data={data.byPriority} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90} label>
                {data.byPriority.map((_: any, i: number) => <Cell key={i} fill={chartColors.palette[i % chartColors.palette.length]} />)}
              </Pie>
              <Tooltip contentStyle={{ background: chartColors.tooltipBg, border: `1px solid ${chartColors.tooltipBorder}`, borderRadius: 8 }} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title={t('chartTasksByType')}>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={data.byType}>
              <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
              <XAxis dataKey="name" tick={{ fontSize: 12, fill: chartColors.axisText }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: chartColors.axisText }} />
              <Tooltip contentStyle={{ background: chartColors.tooltipBg, border: `1px solid ${chartColors.tooltipBorder}`, borderRadius: 8 }} />
              <Bar dataKey="value" fill={chartColors.accent} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title={t('chartSprintVelocity')}>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={data.velocity}>
              <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
              <XAxis dataKey="name" tick={{ fontSize: 12, fill: chartColors.axisText }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: chartColors.axisText }} />
              <Tooltip contentStyle={{ background: chartColors.tooltipBg, border: `1px solid ${chartColors.tooltipBorder}`, borderRadius: 8 }} />
              <Bar dataKey="points" fill={chartColors.primary} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[--radius-card] border border-surface-border bg-surface-card p-5">
      <h3 className="mb-4 text-sm font-semibold text-text-heading">{title}</h3>
      {children}
    </div>
  );
}

'use client';

import { useEffect, useState, memo } from 'react';
import { useTranslations } from 'next-intl';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { Users, Building2 } from 'lucide-react';
import departmentService from '@/services/departmentService';
import { chartColors } from '@/theme/chartColors';
import { motion } from 'framer-motion';

// Rich, vibrant palette for the 3D-style donut
const DONUT_PALETTE = [
  '#006c49', '#10b981', '#f59e0b', '#3b82f6', '#8b5cf6',
  '#ec4899', '#06b6d4', '#ef4444', '#84cc16', '#f97316',
  '#a855f7', '#14b8a6',
];

/** Custom center label rendered in SVG space */
const CenterLabel = ({ total }: { total: number }) => null; // handled via absolute div

/** Custom tooltip */
const CustomTooltip = ({ active, payload, t }: any) => {
  if (active && payload && payload.length) {
    const d = payload[0];
    return (
      <div className="kpi-card px-4 py-3 rounded-xl shadow-xl border border-surface-border text-sm">
        <p className="font-bold text-text-heading mb-0.5 truncate max-w-[180px]">{d.name}</p>
        <p className="text-text-body">
          <span className="font-extrabold text-brand-primary">{d.value}</span>
          {' '}{t('employeesSuffix')}
        </p>
        <p className="text-xs text-text-muted mt-0.5">{d.payload.percentage}% of total</p>
      </div>
    );
  }
  return null;
};

/** Outer glow ring — CSS trick for "3D" depth illusion */
const DonutChart = ({ data, total, t }: { data: any[]; total: number; t: any }) => (
  <div className="relative flex items-center justify-center">
    {/* Glow base — soft shadow behind the donut */}
    <div className="absolute w-[200px] h-[200px] rounded-full"
      style={{
        background: 'radial-gradient(circle, rgba(0,108,73,0.08) 0%, transparent 70%)',
        filter: 'blur(12px)',
      }}
    />
    <ResponsiveContainer width={220} height={220}>
      <PieChart>
        <defs>
          {data.map((_, i) => (
            <filter key={i} id={`shadow-${i}`} x="-20%" y="-20%" width="140%" height="140%">
              <feDropShadow
                dx="0"
                dy="3"
                stdDeviation="3"
                floodColor={DONUT_PALETTE[i % DONUT_PALETTE.length]}
                floodOpacity="0.35"
              />
            </filter>
          ))}
        </defs>
        <Pie
          data={data}
          cx="50%"
          cy="50%"
          innerRadius={68}
          outerRadius={98}
          paddingAngle={3}
          dataKey="value"
          startAngle={90}
          endAngle={-270}
          strokeWidth={0}
        >
          {data.map((entry, index) => (
            <Cell
              key={`cell-${index}`}
              fill={DONUT_PALETTE[index % DONUT_PALETTE.length]}
              filter={`url(#shadow-${index})`}
              style={{ cursor: 'pointer', outline: 'none' }}
            />
          ))}
        </Pie>
        <Tooltip content={<CustomTooltip t={t} />} />
      </PieChart>
    </ResponsiveContainer>
    {/* Center total label */}
    <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
      <span className="text-3xl font-extrabold text-text-heading tracking-tight leading-none">{total}</span>
      <span className="text-[10px] font-bold text-text-muted uppercase tracking-[0.1em] mt-1">Total</span>
    </div>
  </div>
);

const DepartmentDistribution = memo(function DepartmentDistribution() {
  const [data, setData] = useState<any[]>([]);
  const t = useTranslations('departmentDistribution');
  const [loading, setLoading] = useState(true);

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    try {
      const response = await departmentService.getAll();
      const departments = response.data || [];
      const distribution = departments
        .filter((dept: any) => dept._count?.employees > 0)
        .map((dept: any) => ({ name: dept.name, value: dept._count?.employees || 0, percentage: 0 }))
        .sort((a: any, b: any) => b.value - a.value);
      const total = distribution.reduce((sum: number, item: any) => sum + item.value, 0);
      distribution.forEach((item: any) => { item.percentage = ((item.value / total) * 100).toFixed(1); });
      setData(distribution);
    } catch (error) {
      console.error('Failed to load department distribution:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="surface-panel p-6 animate-pulse">
        <div className="h-5 bg-surface-page rounded w-48 mb-6" />
        <div className="h-[220px] bg-surface-page rounded-full mx-auto w-[220px] mb-6" />
        <div className="grid grid-cols-2 gap-2">
          {[1,2,3,4].map(i => <div key={i} className="h-9 bg-surface-page rounded-lg" />)}
        </div>
      </div>
    );
  }

  const totalEmployees = data.reduce((sum, item) => sum + item.value, 0);

  return (
    <div className="surface-panel overflow-hidden h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-surface-border-light">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-brand-primary/10 flex items-center justify-center">
            <Building2 size={18} className="text-brand-primary" strokeWidth={2} />
          </div>
          <div>
            <h3 className="text-sm font-bold text-text-heading">{t('title')}</h3>
            <p className="text-xs text-text-muted mt-0.5">By department breakdown</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-primary/10 rounded-full border border-brand-primary/20">
          <Users size={13} className="text-brand-primary" />
          <span className="text-xs font-bold text-brand-primary">{data.length} depts</span>
        </div>
      </div>

      {/* Chart and Legend Side-by-Side */}
      <div className="flex items-center px-4 py-2 flex-1 min-h-0">
        {/* Left: 3D Donut Chart */}
        <div className="w-[160px] shrink-0 flex justify-center">
          <div className="relative flex items-center justify-center scale-90">
            <DonutChart data={data} total={totalEmployees} t={t} />
          </div>
        </div>

        {/* Right: Legend (Scrollable list) */}
        <div className="flex-1 pl-4 max-h-[160px] overflow-y-auto pr-1 space-y-1.5 scrollbar-thin">
          {data.map((item, index) => (
            <motion.div
              key={index}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: index * 0.04, duration: 0.3 }}
              className="flex items-center gap-2 py-1 rounded-lg hover:bg-surface-page transition-colors group cursor-default"
            >
              {/* Color dot */}
              <div
                className="w-2.5 h-2.5 rounded-full flex-shrink-0 shadow-sm"
                style={{
                  backgroundColor: DONUT_PALETTE[index % DONUT_PALETTE.length],
                  boxShadow: `0 0 6px ${DONUT_PALETTE[index % DONUT_PALETTE.length]}60`,
                }}
              />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-text-body truncate leading-tight">{item.name}</p>
                <p className="text-[10px] text-text-muted leading-tight mt-0.5">{item.value} • {item.percentage}%</p>
              </div>
            </motion.div>
          ))}
        </div>
      </div>

      {/* Footer Total */}
      <div className="mx-5 mb-5 mt-auto">
        <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-r from-brand-primary/8 to-brand-accent/8 rounded-xl border border-brand-primary/15">
          <div className="flex items-center gap-2">
            <Users size={16} className="text-brand-primary" strokeWidth={2} />
            <span className="text-sm font-semibold text-text-body">{t('total')}</span>
          </div>
          <span className="text-xl font-extrabold text-brand-primary">{totalEmployees}</span>
        </div>
      </div>
    </div>
  );
});

export default DepartmentDistribution;

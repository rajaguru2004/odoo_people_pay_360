'use client';

import { useTranslations } from 'next-intl';
import { TrendingUp, TrendingDown, Minus, Users, Clock, Award, Target, Zap } from 'lucide-react';
import { Line } from 'recharts';
import { LineChart, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { chartColors } from '@/theme/chartColors';
import { activeTheme } from '@/theme';

interface PerformanceData {
  employeeCount: number;
  totalAttendance: number;
  presentCount: number;
  lateCount: number;
  attendanceRate: number;
  onTimeRate: number;
  performanceScore: number;
  trend: 'up' | 'down' | 'stable';
  trendPercentage: number;
  lastMonthRate: number;
  topPerformers: Array<{
    id: string;
    employeeCode: string;
    fullName: string;
    position: string;
    attendanceRate: number;
    presentDays: number;
    totalDays: number;
    lateDays: number;
  }>;
  trendData: Array<{
    monthLabel: string;
    attendanceRate: number;
  }>;
}

interface PerformanceDashboardProps {
  data: PerformanceData;
  loading?: boolean;
}

export default function PerformanceDashboard({ data, loading }: PerformanceDashboardProps) {
  const t = useTranslations('performanceDashboard');

  if (loading) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="h-40 bg-slate-100 rounded-xl">{/* neutral */}</div>
        <div className="grid grid-cols-3 gap-4">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-28 bg-slate-100 rounded-xl">{/* neutral */}</div>
          ))}
        </div>
      </div>
    );
  }

  const getTrendIcon = () => {
    if (data.trend === 'up') return <TrendingUp size={18} />;
    if (data.trend === 'down') return <TrendingDown size={18} />;
    return <Minus size={18} />;
  };

  const getScoreColor = (score: number) => {
    if (score >= 90) return 'from-status-success to-status-success';
    if (score >= 75) return 'from-brand-primary to-brand-primary-dark';
    if (score >= 60) return 'from-status-warning to-status-warning';
    return 'from-status-error to-status-error';
  };

  const getScoreBadge = (score: number) => {
    if (score >= 90) return { text: t('excellent'), color: 'bg-status-success-bg text-status-success border-status-success/20' };
    if (score >= 75) return { text: t('good'), color: 'bg-brand-primary-light/20 text-brand-primary border-brand-primary/20' };
    if (score >= 60) return { text: t('fair'), color: 'bg-status-warning-bg text-status-warning border-status-warning/20' };
    return { text: t('needsImprovement'), color: 'bg-status-error-bg text-status-error border-status-error/20' };
  };

  const scoreBadge = getScoreBadge(data.performanceScore);

  return (
    <div className="space-y-4">
      {/* Performance Score Card - Hero Style */}
      <div className={`relative overflow-hidden rounded-[--radius-card] bg-gradient-to-br ${getScoreColor(data.performanceScore)} p-8 text-text-on-brand shadow-xl`}>
        <div className="absolute top-0 end-0 w-64 h-64 bg-white/10 rounded-full -me-32 -mt-32"></div>
        <div className="absolute bottom-0 start-0 w-48 h-48 bg-black/10 rounded-full -ms-24 -mb-24"></div>
        <div className="relative flex items-center justify-between">
          <div>
            <div className="flex items-center gap-3 mb-3">
              <div className="w-12 h-12 rounded-[--radius-card] bg-white/20 backdrop-blur-sm flex items-center justify-center border border-white/30">
                <Zap size={24} />
              </div>
              <div>
                <p className="text-sm font-semibold uppercase tracking-wider opacity-90">
                  {t('performanceScore')}
                </p>
                <span className={`inline-block px-3 py-1 rounded-[--radius-badge] text-xs font-bold mt-1 ${scoreBadge.color} border`}>
                  {scoreBadge.text}
                </span>
              </div>
            </div>
            <div className="flex items-baseline gap-4">
              <span className="text-6xl font-bold tracking-tight">{data.performanceScore.toFixed(1)}</span>
              <span className="text-3xl font-semibold opacity-60">/100</span>
            </div>
          </div>
          <div className="text-end">
            <div className="inline-flex items-center gap-2 px-5 py-3 rounded-[--radius-button] bg-white/20 backdrop-blur-sm border border-white/30">
              {getTrendIcon()}
              <span className="text-2xl font-bold">
                {data.trendPercentage > 0 ? '+' : ''}{data.trendPercentage.toFixed(1)}%
              </span>
            </div>
            <p className="text-sm opacity-75 mt-2 font-medium">{t('comparedToLastMonth')}</p>
          </div>
        </div>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Attendance Rate */}
        <div className="group bg-surface-card rounded-[--radius-card] p-6 border-2 border-surface-border hover:border-brand-primary/45 hover:shadow-lg transition-all">
          <div className="flex items-start justify-between mb-4">
            <div className="w-12 h-12 rounded-[--radius-card] bg-gradient-to-br from-brand-primary to-brand-primary-dark flex items-center justify-center shadow-lg">
              <Users className="text-text-on-brand" size={22} />
            </div>
            <span className={`px-3 py-1 rounded-[--radius-badge] text-xs font-bold border ${
              data.attendanceRate >= 95 ? 'bg-status-success-bg text-status-success border-status-success/20' : 
              data.attendanceRate >= 85 ? 'bg-status-warning-bg text-status-warning border-status-warning/20' : 
              'bg-status-error-bg text-status-error border-status-error/20'
            }`}>
              {data.attendanceRate >= 95 ? t('excellent') : data.attendanceRate >= 85 ? t('good') : t('needsImprovement')}
            </span>
          </div>
          <p className="text-sm font-semibold text-text-muted mb-2">{t('attendanceRate')}</p>
          <p className="text-3xl font-bold text-text-heading mb-3">{data.attendanceRate.toFixed(1)}%</p>
          <div className="flex items-center justify-between text-xs">
            <span className="text-text-muted font-medium">{data.presentCount}/{data.totalAttendance} {t('daySuffix')}</span>
            <div className="w-16 h-1.5 bg-slate-100 rounded-full overflow-hidden"> {/* neutral */}
              <div className="h-full bg-gradient-to-r from-brand-primary to-brand-primary-dark rounded-full transition-all" style={{ width: `${data.attendanceRate}%` }}></div>
            </div>
          </div>
        </div>

        {/* On-Time Rate */}
        <div className="group bg-surface-card rounded-[--radius-card] p-6 border-2 border-surface-border hover:border-status-success/45 hover:shadow-lg transition-all">
          <div className="flex items-start justify-between mb-4">
            <div className="w-12 h-12 rounded-[--radius-card] bg-gradient-to-br from-status-success to-status-success flex items-center justify-center shadow-lg">
              <Clock className="text-white" size={22} />
            </div>
            <span className={`px-3 py-1 rounded-[--radius-badge] text-xs font-bold border ${
              data.onTimeRate >= 95 ? 'bg-status-success-bg text-status-success border-status-success/20' : 
              data.onTimeRate >= 85 ? 'bg-status-warning-bg text-status-warning border-status-warning/20' : 
              'bg-status-error-bg text-status-error border-status-error/20'
            }`}>
              {data.onTimeRate >= 95 ? t('excellent') : data.onTimeRate >= 85 ? t('good') : t('needsImprovement')}
            </span>
          </div>
          <p className="text-sm font-semibold text-text-muted mb-2">{t('onTimeRate')}</p>
          <p className="text-3xl font-bold text-text-heading mb-3">{data.onTimeRate.toFixed(1)}%</p>
          <div className="flex items-center justify-between text-xs">
            <span className="text-text-muted font-medium">{data.lateCount} {t('lateTimesSuffix')}</span>
            <div className="w-16 h-1.5 bg-slate-100 rounded-full overflow-hidden"> {/* neutral */}
              <div className="h-full bg-gradient-to-r from-status-success to-status-success rounded-full transition-all" style={{ width: `${data.onTimeRate}%` }}></div>
            </div>
          </div>
        </div>

        {/* Employee Count */}
        <div className="group bg-surface-card rounded-[--radius-card] p-6 border-2 border-surface-border hover:border-brand-accent/45 hover:shadow-lg transition-all">
          <div className="flex items-start justify-between mb-4">
            <div className="w-12 h-12 rounded-[--radius-card] bg-gradient-to-br from-brand-accent to-brand-accent-dark flex items-center justify-center shadow-lg">
              <Target className="text-text-on-accent" size={22} />
            </div>
            <span className="px-3 py-1 rounded-[--radius-badge] text-xs font-bold bg-brand-accent/10 text-brand-accent border border-brand-accent/20">
              {t('activity')}
            </span>
          </div>
          <p className="text-sm font-semibold text-text-muted mb-2">{t('totalEmployees')}</p>
          <p className="text-3xl font-bold text-text-heading mb-3">{data.employeeCount}</p>
          <div className="flex items-center justify-between text-xs">
            <span className="text-text-muted font-medium">{t('fullyWorking')}</span>
            <div className="w-16 h-1.5 bg-slate-100 rounded-full overflow-hidden"> {/* neutral */}
              <div className="w-full h-full bg-gradient-to-r from-brand-accent to-brand-accent-dark rounded-full"></div>
            </div>
          </div>
        </div>
      </div>

      {/* Trend Chart */}
      {data.trendData && data.trendData.length > 0 && (
        <div className="bg-surface-card rounded-[--radius-card] p-6 border-2 border-surface-border">
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-lg font-bold text-text-heading">{t('trendsLast6Months')}</h3>
            <div className="flex items-center gap-2 text-sm">
              <div className="w-3 h-3 rounded-full bg-brand-primary"></div>
              <span className="text-text-muted font-medium">{t('attendanceRateLegend')}</span>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={data.trendData}>
              <defs>
                <linearGradient id="colorAttendance" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={chartColors.primary} stopOpacity={0.1}/>
                  <stop offset="95%" stopColor={chartColors.primary} stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} vertical={false} />
              <XAxis dataKey="monthLabel" stroke={chartColors.axisText} style={{ fontSize: '13px', fontWeight: 600 }} tickLine={false} axisLine={{ stroke: chartColors.grid }} />
              <YAxis stroke={chartColors.axisText} style={{ fontSize: '13px', fontWeight: 600 }} domain={[0, 100]} tickLine={false} axisLine={{ stroke: chartColors.grid }} tickFormatter={(value) => `${value}%`} />
              <Tooltip 
                contentStyle={{
                  backgroundColor: activeTheme.colors.surfaceOverlay,
                  border: `2px solid ${activeTheme.colors.surfaceBorder}`,
                  borderRadius: activeTheme.shape.radiusCard,
                  fontSize: '13px',
                  fontWeight: 600,
                  padding: '12px',
                  boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)',
                  color: activeTheme.colors.textHeading,
                }}
                formatter={(value: any) => [`${value}%`, t('attendanceRateLegend')]}
              />
              <Line type="monotone" dataKey="attendanceRate" stroke={chartColors.primary} strokeWidth={3} dot={{ fill: chartColors.primary, r: 6, strokeWidth: 2, stroke: '#fff' }} activeDot={{ r: 8, strokeWidth: 2 }} fill="url(#colorAttendance)" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Top Performers */}
      {data.topPerformers && data.topPerformers.length > 0 && (
        <div className="bg-surface-card rounded-[--radius-card] p-6 border-2 border-surface-border">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-[--radius-card] bg-gradient-to-br from-brand-accent to-brand-accent-dark flex items-center justify-center shadow-lg">
              <Award className="text-text-on-accent" size={20} />
            </div>
            <h3 className="text-lg font-bold text-text-heading">{t('topPerformersHeading')}</h3>
          </div>
          <div className="space-y-3">
            {data.topPerformers.map((performer, index) => (
              <div key={performer.id} className="group flex items-center gap-4 p-4 bg-gradient-to-r from-surface-page to-brand-primary-light/10 rounded-[--radius-card] border-2 border-surface-border hover:border-brand-primary/45 hover:shadow-md transition-all">
                <div className={`relative w-12 h-12 rounded-full flex items-center justify-center font-bold text-white shadow-lg ${
                  index === 0 ? 'bg-gradient-to-br from-brand-accent to-brand-accent-dark' :
                  index === 1 ? 'bg-gradient-to-br from-slate-400 to-slate-500' :
                  index === 2 ? 'bg-gradient-to-br from-brand-accent to-brand-accent-dark' :
                  'bg-gradient-to-br from-brand-primary to-brand-primary-dark'
                }`}>
                  {index + 1}
                  {index < 3 && (
                    <div className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-white flex items-center justify-center">
                      <Award size={12} className={
                        index === 0 ? 'text-brand-accent' :
                        index === 1 ? 'text-slate-400' :
                        'text-brand-accent'
                      } />
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-bold text-text-heading truncate group-hover:text-brand-primary transition-colors">
                    {performer.fullName}
                  </p>
                  <p className="text-sm text-text-muted truncate">
                    {performer.position} • {performer.employeeCode}
                  </p>
                </div>
                <div className="text-right">
                  <div className="flex items-center gap-2 mb-1">
                    <div className="w-16 h-2 bg-slate-200 rounded-full overflow-hidden"> {/* neutral */}
                      <div className="h-full bg-gradient-to-r from-brand-primary to-brand-primary-dark rounded-full transition-all" style={{ width: `${performer.attendanceRate}%` }}></div>
                    </div>
                    <p className="text-lg font-bold text-brand-primary min-w-[3rem]">{performer.attendanceRate}%</p>
                  </div>
                  <p className="text-xs text-text-muted font-medium">
                    {performer.presentDays}/{performer.totalDays} {t('daysSuffix')} {performer.lateDays > 0 && ` • ${performer.lateDays} ${t('lateSuffix')}`}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

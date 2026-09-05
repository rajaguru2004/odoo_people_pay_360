'use client';

import { Target, TrendingUp, TrendingDown, Zap } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface AttendanceGaugeProps {
  rate: number;
  previousRate?: number;
  loading?: boolean;
}

export default function AttendanceGauge({ rate, previousRate, loading = false }: AttendanceGaugeProps) {
  const t = useTranslations('attendanceGauge');
  const tc = useTranslations('common');

  if (loading) {
    return (
      <div className="bg-surface-card rounded-[--radius-card] border border-surface-border p-6 shadow-sm">
        <div className="animate-pulse">
          <div className="h-6 bg-surface-border-light rounded-[--radius-button] w-32 mb-4"></div>
          <div className="h-48 bg-surface-border-light rounded-full mx-auto w-48"></div>
        </div>
      </div>
    );
  }

  const change = previousRate ? rate - previousRate : 0;
  const isImproving = change > 0;

  // Calculate color based on rate
  const getColor = (rate: number) => {
    if (rate >= 95) return { 
      bg: 'bg-status-success', 
      text: 'text-status-success', 
      light: 'bg-status-success-bg',
      border: 'border-status-success/20',
      gradient: 'from-status-success to-status-success/80'
    };
    if (rate >= 85) return { 
      bg: 'bg-brand-primary', 
      text: 'text-brand-primary', 
      light: 'bg-brand-primary-light/20',
      border: 'border-brand-primary-light/30',
      gradient: 'from-brand-primary to-brand-primary-dark'
    };
    if (rate >= 75) return { 
      bg: 'bg-status-warning', 
      text: 'text-status-warning', 
      light: 'bg-status-warning-bg',
      border: 'border-status-warning/20',
      gradient: 'from-status-warning to-status-warning/80'
    };
    return { 
      bg: 'bg-status-error', 
      text: 'text-status-error', 
      light: 'bg-status-error-bg',
      border: 'border-status-error/20',
      gradient: 'from-status-error to-status-error/80'
    };
  };

  const color = getColor(rate);
  const circumference = 2 * Math.PI * 65; // radius = 65
  const strokeDashoffset = circumference - (rate / 100) * circumference;

  return (
    <div className="bg-surface-card rounded-[--radius-card] border border-surface-border shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-6 py-5 border-b border-surface-border bg-gradient-to-r from-surface-border-light to-surface-card">
        <div>
          <h3 className="text-lg font-bold text-text-heading flex items-center gap-2">
            <div className={`p-2 ${color.light} rounded-[--radius-button]`}>
              <Target size={20} className={color.text} />
            </div>
            {t('title')}
          </h3>
          <p className="text-sm text-text-muted mt-1 ms-11">{tc('today')}</p>
        </div>
      </div>

      {/* Gauge */}
      <div className="p-6">
        <div className="relative flex items-center justify-center mb-4">
          <svg className="transform -rotate-90" width="180" height="180">
            {/* Background circle */}
            <circle cx="90" cy="90" r="65" stroke="var(--color-surface-border)" strokeWidth="14" fill="none" />
            
            {/* Progress circle */}
            <circle
              cx="90"
              cy="90"
              r="65"
              stroke="currentColor"
              strokeWidth="14"
              fill="none"
              strokeDasharray={circumference}
              strokeDashoffset={strokeDashoffset}
              strokeLinecap="round"
              className={color.text}
              style={{
                transition: 'stroke-dashoffset 1s ease-in-out',
                filter: 'drop-shadow(0 0 8px currentColor)'
              }}
            />
          </svg>

          {/* Center content */}
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <div className={`p-2.5 ${color.light} rounded-full mb-2`}>
              <Zap size={20} className={color.text} />
            </div>
            <p className={`text-3xl font-bold ${color.text}`}>{rate}%</p>
            <p className="text-xs text-text-muted mt-1 font-medium">{t('presence')}</p>
          </div>
        </div>

        {/* Stats */}
        <div className="space-y-2.5">
          {/* Change indicator */}
          {previousRate !== undefined && (
            <div className={`flex items-center justify-center gap-2 p-2.5 rounded-[--radius-button] ${color.light} border ${color.border}`}>
              {isImproving ? (
                <>
                  <TrendingUp size={16} className={color.text} />
                  <span className={`text-sm font-bold ${color.text}`}>
                    +{change.toFixed(1)}% {t('comparedToYesterday')}
                  </span>
                </>
              ) : (
                <>
                  <TrendingDown size={16} className={color.text} />
                  <span className={`text-sm font-bold ${color.text}`}>
                    {change.toFixed(1)}% {t('comparedToYesterday')}
                  </span>
                </>
              )}
            </div>
          )}

          {/* Status message */}
          <div className={`text-center p-3 rounded-[--radius-button] ${color.light} border ${color.border}`}>
            {rate >= 95 && (
              <div>
                <p className={`text-base font-bold ${color.text} mb-0.5`}>{t('excellent')}</p>
                <p className="text-xs text-text-muted">{t('excellentDesc')}</p>
              </div>
            )}
            {rate >= 85 && rate < 95 && (
              <div>
                <p className={`text-base font-bold ${color.text} mb-0.5`}>{t('good')}</p>
                <p className="text-xs text-text-muted">{t('goodDesc')}</p>
              </div>
            )}
            {rate >= 75 && rate < 85 && (
              <div>
                <p className={`text-base font-bold ${color.text} mb-0.5`}>{t('needsImprovement')}</p>
                <p className="text-xs text-text-muted">{t('needsImprovementDesc')}</p>
              </div>
            )}
            {rate < 75 && (
              <div>
                <p className={`text-base font-bold ${color.text} mb-0.5`}>{t('attentionNeeded')}</p>
                <p className="text-xs text-text-muted">{t('attentionNeededDesc')}</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Globe } from 'lucide-react';
import visaService from '@/services/visaService';
import { VisaRecord } from '@/types/visa';
import { formatDate } from '@/utils/formatters';

export default function VisaExpiryWidget() {
  const router = useRouter();
  const t = useTranslations('visas');
  const [visas, setVisas] = useState<VisaRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);

  useEffect(() => {
    const fetchExpiring = async () => {
      try {
        setLoading(true);
        const response = await visaService.getExpiring(days);
        if (response.success && response.data) {
          setVisas(response.data);
        }
      } catch (error) {
        console.error('Failed to fetch expiring visas:', error);
      } finally {
        setLoading(false);
      }
    };
    fetchExpiring();
  }, [days]);

  const getUrgencyColor = (daysLeft: number) => {
    if (daysLeft <= 7) return 'text-status-error bg-status-error-bg';
    if (daysLeft <= 15) return 'text-status-warning bg-status-warning-bg';
    return 'text-status-info bg-status-info-bg';
  };

  return (
    <div className="bg-surface-card rounded-lg shadow-sm p-6 border border-surface-border">
      {/* Header */}
      <div className="flex justify-between items-center mb-4">
        <div>
          <h3 className="text-lg font-semibold text-text-heading">{t('widgetTitle')}</h3>
          <p className="text-sm text-text-muted mt-1">
            {visas.length} · {days}d
          </p>
        </div>
        <select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          className="px-3 py-1 border border-surface-border bg-surface-card text-text-body rounded-lg text-sm focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary"
        >
          <option value={7}>7d</option>
          <option value={15}>15d</option>
          <option value={30}>30d</option>
          <option value={60}>60d</option>
        </select>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-primary"></div>
        </div>
      ) : visas.length === 0 ? (
        <div className="text-center py-8">
          <Globe className="w-12 h-12 text-text-muted mx-auto mb-3" />
          <p className="text-text-muted">{t('widgetEmpty')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {visas.slice(0, 5).map((visa) => (
            <div
              key={visa.id}
              onClick={() =>
                router.push(`/dashboard/employees/${visa.employeeId}?section=visa`)
              }
              className="flex items-center justify-between p-3 border border-surface-border rounded-lg hover:bg-surface-page cursor-pointer transition-colors"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-text-heading truncate">
                  {visa.employee?.fullName}
                </p>
                <p className="text-xs text-text-muted mt-1">
                  {visa.documentType} • {visa.country} • {visa.documentNumber}
                </p>
                <p className="text-xs text-text-muted mt-1">
                  {t('expiryDate')}: {formatDate(visa.expiryDate)}
                </p>
              </div>
              <div
                className={`ms-3 px-2 py-1 rounded-full text-xs font-medium ${getUrgencyColor(visa.daysUntilExpiry)}`}
              >
                {t('daysCount', { count: visa.daysUntilExpiry })}
              </div>
            </div>
          ))}

          {visas.length > 5 && (
            <button
              onClick={() => router.push('/dashboard/visa-reports')}
              className="w-full py-2 text-sm text-brand-primary hover:text-brand-primary-dark font-medium"
            >
              {t('viewAll')} ({visas.length}) →
            </button>
          )}
        </div>
      )}
    </div>
  );
}

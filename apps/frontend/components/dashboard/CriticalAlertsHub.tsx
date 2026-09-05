'use client';

import { useEffect, useState } from 'react';
import { getCompanyTz } from '@/utils/formatters';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Clock, FileText, Zap, ChevronRight, ChevronDown, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslations } from 'next-intl';
import { useAuthStore } from '@/store/authStore';

interface Alert {
  id: string;
  type: 'contract' | 'leave' | 'attendance' | 'overtime';
  title: string;
  count: number;
  severity: 'critical' | 'warning' | 'info';
  link: string;
  items?: Array<{
    name: string;
    detail: string;
    daysLeft?: number;
  }>;
}

export default function CriticalAlertsHub() {
  const router = useRouter();
  const { user } = useAuthStore();
  const t = useTranslations('criticalAlerts');
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedAlert, setExpandedAlert] = useState<string | null>(null);

  useEffect(() => {
    fetchAlerts();
  }, []);

  const fetchAlerts = async () => {
    try {
      const axiosInstance = (await import('@/lib/axios')).default;
      
      // Single API call to get all alerts
      const response: any = await axiosInstance.get('/dashboard/alerts');
      
      if (response?.success && response?.data) {
        const alertsData = response.data;
        const allAlerts: Alert[] = [];

        // 1. Expiring Contracts
        const canViewContracts = user?.role === 'ADMIN' || user?.role === 'HR_MANAGER';
        if (canViewContracts && alertsData.expiringContracts && alertsData.expiringContracts.length > 0) {
          const items = alertsData.expiringContracts.slice(0, 3).map((contract: any) => ({
            name: contract.employee?.fullName || 'N/A',
            detail: contract.employee?.employeeCode || 'N/A',
            daysLeft: contract.daysRemaining
          }));

          allAlerts.push({
            id: 'contracts',
            type: 'contract',
            title: t('expiringContractsTitle'),
            count: alertsData.expiringContracts.length,
            severity: alertsData.expiringContracts.some((c: any) => c.daysRemaining <= 7) ? 'critical' : 'warning',
            link: '/dashboard/employees?filter=expiring-contracts',
            items
          });
        }

        // 2. Pending Leave Requests
        if (alertsData.pendingLeaveRequests && alertsData.pendingLeaveRequests.length > 0) {
          const items = alertsData.pendingLeaveRequests.slice(0, 3).map((lr: any) => ({
            name: lr.employee?.fullName || 'N/A',
            detail: `${lr.leaveType} • ${lr.totalDays} day${lr.totalDays > 1 ? 's' : ''} from ${new Date(lr.startDate).toLocaleDateString('en-IN', { timeZone: getCompanyTz() })}`
          }));

          allAlerts.push({
            id: 'leaves',
            type: 'leave',
            title: t('pendingLeaveTitle'),
            count: alertsData.pendingLeaveRequests.length,
            severity: 'warning',
            link: '/dashboard/leaves?status=pending',
            items
          });
        }

        // 3. Frequent Late Employees
        if (alertsData.frequentLateEmployees) {
          const lateCount = alertsData.frequentLateEmployees.filter((e: any) => e.lateCount >= 3).length;
          if (lateCount > 0) {
            const items = alertsData.frequentLateEmployees
              .filter((e: any) => e.lateCount >= 3)
              .slice(0, 3)
              .map((e: any) => ({
                name: e.employee?.fullName || 'N/A',
                detail: `Late check-ins: ${e.lateCount} time${e.lateCount > 1 ? 's' : ''}`
              }));

            allAlerts.push({
              id: 'attendance',
              type: 'attendance',
              title: t('frequentlyLateTitle'),
              count: lateCount,
              severity: 'warning',
              link: '/dashboard/attendance?status=late',
              items
            });
          }
        }

        // 4. Pending Overtime Requests (now included in alerts response)
        if (alertsData.pendingOvertimeCount && alertsData.pendingOvertimeCount > 0) {
          const items = alertsData.pendingOvertimeRequests
            ? alertsData.pendingOvertimeRequests.slice(0, 3).map((ot: any) => ({
                name: ot.employee?.fullName || 'N/A',
                detail: `Hours: ${ot.hours} • ${ot.reason || 'No reason'} • ${new Date(ot.date).toLocaleDateString('en-IN', { timeZone: getCompanyTz() })}`
              }))
            : [];

          allAlerts.push({
            id: 'overtime',
            type: 'overtime',
            title: t('pendingOvertimeTitle'),
            count: alertsData.pendingOvertimeCount,
            severity: 'info',
            link: '/dashboard/overtime?status=pending',
            items
          });
        }

        setAlerts(allAlerts);
      }
    } catch (error) {
      console.error('Failed to fetch alerts:', error);
      setAlerts([]);
    } finally {
      setLoading(false);
    }
  };

  const getIcon = (type: Alert['type']) => {
    switch (type) {
      case 'contract': return Clock;
      case 'leave': return FileText;
      case 'attendance': return AlertTriangle;
      case 'overtime': return Zap;
    }
  };

  const getSeverityColor = (severity: Alert['severity']) => {
    switch (severity) {
      case 'critical':
        return {
          bg: 'bg-status-error-bg',
          border: 'border-status-error/20',
          text: 'text-status-error',
          badge: 'bg-status-error/10 text-status-error',
          icon: 'text-status-error'
        };
      case 'warning':
        return {
          bg: 'bg-status-warning-bg',
          border: 'border-status-warning/20',
          text: 'text-status-warning',
          badge: 'bg-status-warning/10 text-status-warning',
          icon: 'text-status-warning'
        };
      case 'info':
        return {
          bg: 'bg-status-info-bg',
          border: 'border-status-info/20',
          text: 'text-status-info',
          badge: 'bg-status-info/10 text-status-info',
          icon: 'text-status-info'
        };
    }
  };

  if (loading) {
    return (
      <div className="bg-surface-card rounded-xl border border-surface-border p-6 shadow-sm">
        <div className="animate-pulse space-y-4">
          <div className="h-6 bg-surface-page rounded w-48"></div>
          <div className="space-y-3">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-20 bg-surface-page rounded"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const totalAlerts = alerts.reduce((sum, alert) => sum + alert.count, 0);

  return (
    <div className="bg-surface-card rounded-xl border border-surface-border shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-surface-border bg-linear-to-r from-status-error-bg/30 to-status-warning-bg/30">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-status-error-bg rounded-lg">
              <AlertTriangle size={20} className="text-status-error" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-text-heading">{t('title')}</h3>
              <p className="text-sm text-text-muted mt-0.5">{t('problemsToHandle', { count: totalAlerts })}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Alerts List */}
      <div className="p-4">
        {alerts.length === 0 ? (
          <div className="text-center py-6">
            <div className="w-16 h-16 bg-status-success-bg rounded-full flex items-center justify-center mx-auto mb-3">
              <AlertTriangle size={32} className="text-status-success" />
            </div>
            <p className="text-sm font-medium text-text-heading">{t('noWarnings')}</p>
            <p className="text-xs text-text-muted mt-1">{t('everythingFine')}</p>
          </div>
        ) : (
          <div className="space-y-3">
            {alerts.map((alert, index) => {
              const Icon = getIcon(alert.type);
              const colors = getSeverityColor(alert.severity);
              return (
                <motion.div
                  key={alert.id}
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: index * 0.1 }}
                  className={`${colors?.bg} ${colors?.border} border rounded-xl overflow-hidden`}
                >
                  {/* Alert Header - Clickable */}
                  <div
                    onClick={() => setExpandedAlert(alert.id)}
                    className="py-3 px-4 cursor-pointer hover:bg-opacity-80 transition-all"
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-3 flex-1">
                        <div className={`p-2 ${colors?.badge} rounded-lg`}>
                          <Icon size={18} className={colors?.icon} />
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-0.5">
                            <h4 className={`font-semibold ${colors?.text}`}>{alert.title}</h4>
                            <span className={`px-2 py-0.5 ${colors?.badge} rounded-full text-[10px] font-bold`}>
                              {alert.count}
                            </span>
                          </div>
                          {/* Preview items for contracts when collapsed */}
                          {alert.items && alert.items.length > 0 && (
                            <div className="mt-1">
                              <div className="flex items-center justify-between text-xs">
                                <span className="text-text-body">{alert.items[0].name}</span>
                                {alert.items[0].daysLeft !== undefined && (
                                  <span className={`font-semibold ${colors?.text}`}>
                                    {t('daysLeft', { count: alert.items[0].daysLeft })}
                                  </span>
                                )}
                              </div>
                              {alert.count > 1 && (
                                <p className="text-xs text-text-muted mt-1">
                                  {t('othersCount', { count: alert.count - 1 })}
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <ChevronRight
                          size={20}
                          className="text-text-muted"
                        />
                      </div>
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </div>
        )}
      </div>

      {/* Pop-up Modal */}
      <AnimatePresence>
        {expandedAlert && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
            onClick={() => setExpandedAlert(null)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-md bg-surface-card rounded-2xl shadow-xl overflow-hidden border border-surface-border flex flex-col max-h-[85vh]"
            >
              {(() => {
                const alert = alerts.find(a => a.id === expandedAlert);
                if (!alert) return null;
                const Icon = getIcon(alert.type);
                const colors = getSeverityColor(alert.severity);

                return (
                  <>
                    <div className={`px-6 py-4 border-b border-surface-border ${colors?.bg} flex items-center justify-between shrink-0`}>
                      <div className="flex items-center gap-3">
                        <div className={`p-2 ${colors?.badge} rounded-lg`}>
                          <Icon size={20} className={colors?.icon} />
                        </div>
                        <div>
                          <h3 className={`text-lg font-bold ${colors?.text}`}>{alert.title}</h3>
                          <p className="text-sm text-text-muted mt-0.5">{alert.count} items</p>
                        </div>
                      </div>
                      <button
                        onClick={() => setExpandedAlert(null)}
                        className="p-2 text-text-muted hover:text-text-heading hover:bg-surface-page rounded-xl transition-colors"
                      >
                        <X size={20} />
                      </button>
                    </div>
                    
                    <div className="p-4 space-y-2 overflow-y-auto min-h-0">
                      {alert.items && alert.items.map((item, idx) => (
                        <div key={idx} className="flex flex-col sm:flex-row sm:items-center justify-between py-3 px-4 bg-surface-page rounded-xl hover:bg-surface-border-light transition-colors gap-2">
                          <div>
                            <p className="text-sm font-semibold text-text-heading">{item.name}</p>
                            <p className="text-xs text-text-muted mt-0.5">{item.detail}</p>
                          </div>
                          {item.daysLeft !== undefined && (
                            <span className={`text-sm font-bold ${colors?.text} shrink-0`}>
                              {t('remainingOn', { count: item.daysLeft })}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>

                    <div className="p-4 border-t border-surface-border bg-surface-page shrink-0">
                      <button
                        onClick={() => {
                          setExpandedAlert(null);
                          router.push(alert.link);
                        }}
                        className="w-full py-2.5 text-sm font-bold text-text-on-brand bg-brand-primary hover:bg-brand-primary-dark rounded-[--radius-button] transition-colors shadow-sm"
                      >
                        {t('seeAll')}
                      </button>
                    </div>
                  </>
                );
              })()}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, Calendar, FileText, ArrowRight } from 'lucide-react';
import dashboardService, {
    ContractAlert,
    AlertSeverity,
} from '@/services/dashboardService';
import { toast } from '@/lib/toast';

interface ContractExpirationAlertsProps {
    days?: number;
    maxDisplay?: number;
}

export default function ContractExpirationAlerts({
    days = 60,
    maxDisplay = 10,
}: ContractExpirationAlertsProps) {
    const router = useRouter();
    const [alerts, setAlerts] = useState<ContractAlert[]>([]);
    const [loading, setLoading] = useState(true);
    const [bySeverity, setBySeverity] = useState<Record<AlertSeverity, number>>({
        HIGH: 0,
        MEDIUM: 0,
        LOW: 0,
        INFO: 0,
    });

    useEffect(() => {
        fetchAlerts();
    }, [days]);

    const fetchAlerts = async () => {
        try {
            setLoading(true);
            const response = await dashboardService.getContractAlerts(days);
            if (response.data) {
                setAlerts(response.data.alerts.slice(0, maxDisplay));
                setBySeverity(response.data.bySeverity);
            }
        } catch (error: any) {
            console.error('Error fetching contract alerts:', error);
            toast.error('Unable to load contract warnings');
        } finally {
            setLoading(false);
        }
    };

    const getSeverityColor = (severity: AlertSeverity): string => {
        switch (severity) {
            case 'HIGH':
                return 'bg-status-error-bg text-status-error border-status-error/20';
            case 'MEDIUM':
                return 'bg-status-warning-bg text-status-warning border-status-warning/20';
            case 'LOW':
                return 'bg-status-warning-bg text-status-warning border-status-warning/20';
            case 'INFO':
                return 'bg-status-info-bg text-status-info border-status-info/20';
            default:
                return 'bg-surface-border-light text-text-body border-surface-border';
        }
    };

    const getSeverityIcon = (severity: AlertSeverity): string => {
        switch (severity) {
            case 'HIGH':
                return '🔴';
            case 'MEDIUM':
                return '🟠';
            case 'LOW':
                return '🟡';
            case 'INFO':
                return '🔵';
            default:
                return '⚪';
        }
    };

    const getSeverityLabel = (severity: AlertSeverity): string => {
        switch (severity) {
            case 'HIGH':
                return 'Urgent';
            case 'MEDIUM':
                return 'Important';
            case 'LOW':
                return 'Normal';
            case 'INFO':
                return 'Information';
            default:
                return 'Not determined';
        }
    };

    const getContractTypeLabel = (type: string): string => {
        switch (type) {
            case 'PROBATION':
                return 'Probation';
            case 'FIXED_TERM':
                return 'Fixed Term';
            case 'INDEFINITE':
                return 'Indefinite';
            default:
                return type;
        }
    };

    const formatDate = (dateString: string): string => {
        const date = new Date(dateString);
        return date.toLocaleDateString('en-US', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
        });
    };

    const handleAlertClick = (contractId: string) => {
        router.push(`/dashboard/contracts/${contractId}`);
    };

    if (loading) {
        return (
            <div className="bg-surface-card rounded-[--radius-card] border border-surface-border p-6 shadow-sm">
                <div className="animate-pulse">
                    <div className="h-6 bg-surface-border-light rounded-[--radius-button] w-1/3 mb-4"></div>
                    <div className="space-y-3">
                        {[1, 2, 3].map((i) => (
                            <div key={i} className="h-16 bg-surface-border-light rounded-[--radius-card]"></div>
                        ))}
                    </div>
                </div>
            </div>
        );
    }

    const totalAlerts = alerts.length;

    return (
        <div className="bg-surface-card rounded-[--radius-card] border border-surface-border shadow-sm overflow-hidden">
            {/* Header */}
            <div className="p-6 border-b border-surface-border bg-gradient-to-r from-surface-border-light to-surface-card">
                <div className="flex items-center justify-between">
                    <div>
                        <h2 className="text-xl font-bold text-text-heading flex items-center gap-2">
                            <Calendar className="text-brand-primary" size={22} />
                            Contract Expiration Warnings
                        </h2>
                        <p className="text-sm text-text-muted mt-1">
                            {totalAlerts} contract{totalAlerts !== 1 ? 's' : ''} will expire in {days} days
                        </p>
                    </div>
                    <button
                        onClick={() => router.push('/dashboard/contracts')}
                        className="flex items-center gap-1.5 text-sm text-brand-primary hover:text-brand-primary-dark font-semibold transition-colors"
                    >
                        See all <ArrowRight size={16} />
                    </button>
                </div>

                {/* Severity Summary */}
                <div className="grid grid-cols-4 gap-3 mt-4">
                    {(['HIGH', 'MEDIUM', 'LOW', 'INFO'] as AlertSeverity[]).map((severity) => {
                        const colors = getSeverityColor(severity);
                        return (
                            <div key={severity} className={`p-3 rounded-[--radius-card] border ${colors} shadow-xs`} >
                                <div className="flex items-center justify-between">
                                    <span className="text-xl">{getSeverityIcon(severity)}</span>
                                    <span className="text-xl font-bold">{bySeverity[severity] || 0}</span>
                                </div>
                                <p className="text-[10px] mt-1 font-bold tracking-wider uppercase opacity-85">
                                    {getSeverityLabel(severity)}
                                </p>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* Alerts List */}
            <div className="divide-y divide-surface-border-light">
                {alerts.length === 0 ? (
                    <div className="p-8 text-center text-text-muted">
                        <FileText className="mx-auto h-12 w-12 text-text-muted/40 mb-2" />
                        <p className="text-sm font-medium">No expiring contracts</p>
                    </div>
                ) : (
                    alerts.map((alert) => (
                        <div
                          key={alert.contractId}
                          onClick={() => handleAlertClick(alert.contractId)}
                          className="p-4 hover:bg-surface-border-light cursor-pointer transition-colors"
                        >
                            <div className="flex items-start justify-between">
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                        <span className="text-base">{getSeverityIcon(alert.severity)}</span>
                                        <h3 className="font-bold text-text-heading truncate">
                                            {alert.employeeName}
                                        </h3>
                                        <span className={`px-2 py-0.5 text-[10px] font-bold tracking-wide uppercase rounded-[--radius-badge] border ${getSeverityColor(alert.severity)}`} >
                                            {getSeverityLabel(alert.severity)}
                                        </span>
                                    </div>
                                    
                                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
                                        <span>NV Code: {alert.employeeCode}</span>
                                        <span>•</span>
                                        <span>Type: {getContractTypeLabel(alert.contractType)}</span>
                                        {alert.contractNumber && (
                                            <>
                                                <span>•</span>
                                                <span>Number: {alert.contractNumber}</span>
                                            </>
                                        )}
                                    </div>
                                    
                                    <div className="mt-2.5 flex items-center gap-2 text-xs text-text-muted">
                                        <Calendar size={14} className="text-text-muted/60" />
                                        <span>Expiration Date: {formatDate(alert.expirationDate)}</span>
                                    </div>
                                </div>

                                <div className="text-right ml-4 shrink-0">
                                    <div className={`text-2xl font-black ${
                                        alert.daysRemaining <= 7 ? 'text-status-error'
                                            : alert.daysRemaining <= 15 ? 'text-status-warning'
                                            : alert.daysRemaining <= 30 ? 'text-status-warning'
                                            : 'text-brand-primary'}`}
                                    >
                                        {alert.daysRemaining}
                                    </div>
                                    <div className="text-[10px] font-bold uppercase tracking-wider text-text-muted mt-0.5">days left</div>
                                </div>
                            </div>
                        </div>
                    ))
                )}
            </div>

            {/* Footer */}
            {alerts.length > 0 && (
                <div className="p-4 bg-surface-border-light border-t border-surface-border">
                    <button
                        onClick={() => router.push('/dashboard/contracts?filter=expiring')}
                        className="w-full text-center text-sm text-brand-primary hover:text-brand-primary-dark font-bold transition-colors"
                    >
                        See all {totalAlerts} warnings
                    </button>
                </div>
            )}
        </div>
    );
}

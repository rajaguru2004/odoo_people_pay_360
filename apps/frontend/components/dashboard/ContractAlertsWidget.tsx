'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import dashboardService, { AlertSeverity } from '@/services/dashboardService';

export default function ContractAlertsWidget() {
    const router = useRouter();
    const [bySeverity, setBySeverity] = useState<Record<AlertSeverity, number>>({
        HIGH: 0,
        MEDIUM: 0,
        LOW: 0,
        INFO: 0,
    });
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetchAlerts();
    }, []);

    const fetchAlerts = async () => {
        try {
            const response = await dashboardService.getContractAlerts(60);
            if (response.data) {
                setBySeverity(response.data.bySeverity);
                setTotal(response.data.total);
            }
        } catch (error) {
            console.error('Error fetching contract alerts:', error);
        } finally {
            setLoading(false);
        }
    };

    const getSeverityColor = (severity: AlertSeverity): string => {
        switch (severity) {
            case 'HIGH':
                return 'bg-red-500';
            case 'MEDIUM':
                return 'bg-brand-accent';
            case 'LOW':
                return 'bg-yellow-500';
            case 'INFO':
                return 'bg-brand-primary-light/100';
            default:
                return 'bg-gray-500';
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
                return '';
        }
    };

    if (loading) {
        return (
            <div className="surface-panel p-6">
                <div className="animate-pulse">
                    <div className="h-4 bg-gray-200 rounded w-1/2 mb-4"></div>
                    <div className="h-8 bg-gray-200 rounded w-1/3"></div>
                </div>
            </div>
        );
    }

    return (
        <div
            onClick={() => router.push('/dashboard/contracts?filter=expiring')} className="surface-panel surface-panel-interactive p-6 cursor-pointer" > <div className="flex items-center justify-between mb-4"> <h3 className="text-sm font-medium text-gray-600"> Contract is about to expire </h3> <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" > <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /> </svg> </div> <div className="flex items-baseline gap-2 mb-4"> <span className="text-3xl font-bold text-gray-900">{total}</span> <span className="text-sm text-gray-500">contract</span> </div> {/* Severity Breakdown */} <div className="space-y-2"> {(['HIGH', 'MEDIUM', 'LOW', 'INFO'] as AlertSeverity[]).map(
                    (severity) =>
                        bySeverity[severity] > 0 && (
                            <div key={severity} className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <div
                                        className={`w-2 h-2 rounded-full ${getSeverityColor(severity)}`}
                                    ></div>
                                    <span className="text-sm text-gray-600">
                                        {getSeverityLabel(severity)}
                                    </span>
                                </div>
                                <span className="text-sm font-medium text-gray-900">
                                    {bySeverity[severity]}
                                </span>
                            </div>
                        ),
                )}
            </div>

            {total === 0 && (
                <p className="text-sm text-gray-500 text-center py-4"> There are no expiring contracts </p> )} {/* View All Link */} {total > 0 && ( <div className="mt-4 pt-4 border-t border-gray-200">
                    <span className="text-sm text-brand-primary hover:text-brand-primary font-medium">
                        See details →
                    </span>
                </div>
            )}
        </div>
    );
}

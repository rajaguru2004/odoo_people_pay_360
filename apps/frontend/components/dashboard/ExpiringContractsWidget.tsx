'use client';

import { useState, useEffect } from 'react';
import { getCompanyTz } from '@/utils/formatters';
import { useRouter } from 'next/navigation';
import contractService from '@/services/contractService';
import { ExpiringContract } from '@/types/contract';

export default function ExpiringContractsWidget() {
    const router = useRouter();
    const [contracts, setContracts] = useState<ExpiringContract[]>([]);
    const [loading, setLoading] = useState(true);
    const [days, setDays] = useState(30);

    useEffect(() => {
        fetchExpiringContracts();
    }, [days]);

    const fetchExpiringContracts = async () => {
        try {
            setLoading(true);
            const response = await contractService.getExpiring(days);
            if (response.success && response.data) {
                setContracts(response.data);
            }
        } catch (error) {
            console.error('Failed to fetch expiring contracts:', error);
        } finally {
            setLoading(false);
        }
    };

    const formatDate = (date: string) => {
        return new Date(date).toLocaleDateString('en-IN', { timeZone: getCompanyTz() });
    };

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
          <h3 className="text-lg font-semibold text-text-heading">Contract about to expire</h3>
          <p className="text-sm text-text-muted mt-1">
            {contracts.length} contract will expire in {days} days
          </p>
        </div>
        <select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          className="px-3 py-1 border border-surface-border bg-surface-card text-text-body rounded-lg text-sm focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary"
        >
          <option value={7}>7 days</option>
          <option value={15}>15 days</option>
          <option value={30}>30 days</option>
          <option value={60}>60 days</option>
        </select>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-primary"></div>
        </div>
      ) : contracts.length === 0 ? (
        <div className="text-center py-8">
          <svg className="w-12 h-12 text-text-muted mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-text-muted">No expiring contracts</p>
        </div>
      ) : (
        <div className="space-y-3">
          {contracts.slice(0, 5).map(({ contract, daysUntilExpiry }) => (
            <div
              key={contract.id}
              onClick={() => router.push(`/dashboard/contracts/${contract.id}`)}
              className="flex items-center justify-between p-3 border border-surface-border rounded-lg hover:bg-surface-page cursor-pointer transition-colors"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-text-heading truncate">
                  {contract.employee.fullName}
                </p>
                <p className="text-xs text-text-muted mt-1">
                  {contract.employee.position} • {contract.contractNumber}
                </p>
                <p className="text-xs text-text-muted mt-1">
                  Expires: {contract.endDate ? formatDate(contract.endDate) : 'N/A'}
                </p>
              </div>
              <div className={`ml-3 px-2 py-1 rounded-full text-xs font-medium ${getUrgencyColor(daysUntilExpiry)}`}>
                {daysUntilExpiry === 0 ? 'Today' : `${daysUntilExpiry} days`}
              </div>
            </div>
          ))}

          {contracts.length > 5 && (
            <button
              onClick={() => router.push('/dashboard/contracts?status=ACTIVE')}
              className="w-full py-2 text-sm text-brand-primary hover:text-brand-primary-dark font-medium"
            >
              See all {contracts.length} contract →
            </button>
          )}
        </div>
      )}
    </div>
  );
}

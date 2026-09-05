'use client';

import { useEffect, useState } from 'react';
import { useAuthStore } from '@/store/authStore';
import { useRouter } from 'next/navigation';
import leaveService from '@/services/leaveService';
import {
  Calendar, Clock, Users, Loader2,
  TrendingUp, AlertCircle, ChevronDown, ChevronUp
} from 'lucide-react';
import PageActionRow from '@/components/common/PageActionRow';
import DataCard from '@/components/common/DataCard';
import EmptyState from '@/components/common/EmptyState';
import { usePageHeader } from '@/hooks/usePageHeader';

interface TeamBalance {
  employeeId: string;
  employeeCode: string;
  fullName: string;
  position: string;
  balances: {
    annual: { total: number; used: number; remaining: number };
    sick: { total: number; used: number; remaining: number };
    carriedOver: number;
  } | null;
}

function BalancePill({
  label,
  used,
  total,
  color,
}: {
  label: string;
  used: number;
  total: number;
  color: string;
}) {
  const pct = total > 0 ? Math.min((used / total) * 100, 100) : 0;
  return (
    <div className="space-y-1 md:min-w-[100px]">
      <div className="flex justify-between text-xs text-text-muted">
        <span className="font-medium">{label}</span>
        <span>
          {used}/{total}d
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-surface-page overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export default function TeamBalancesPage() {
  const { user } = useAuthStore();
  const router = useRouter();
  const [balances, setBalances] = useState<TeamBalance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortField, setSortField] = useState<'fullName' | 'annual' | 'sick'>('fullName');
  const [sortAsc, setSortAsc] = useState(true);

  // The one heading for this route, rendered by TopHeader. Declared above the
  // loading early-return so the hook order never changes between renders.
  usePageHeader(
    'Team Leave Balances',
    `${new Date().getFullYear()} leave balance overview for your department`,
  );

  useEffect(() => {
    if (user?.role !== 'MANAGER') {
      router.replace('/dashboard');
      return;
    }
    fetchBalances();
  }, [user]);

  const fetchBalances = async () => {
    try {
      setLoading(true);
      const res = await leaveService.getTeamBalances();
      const data: TeamBalance[] = (res as any)?.data?.data ?? (res as any)?.data ?? [];
      setBalances(data);
    } catch (e: any) {
      setError(e?.response?.data?.message || 'Failed to load team balances');
    } finally {
      setLoading(false);
    }
  };

  const toggleSort = (field: 'fullName' | 'annual' | 'sick') => {
    if (sortField === field) setSortAsc(!sortAsc);
    else {
      setSortField(field);
      setSortAsc(true);
    }
  };

  const sorted = [...balances].sort((a, b) => {
    let valA: any, valB: any;
    if (sortField === 'fullName') {
      valA = a.fullName;
      valB = b.fullName;
    } else if (sortField === 'annual') {
      valA = a.balances?.annual.remaining ?? -1;
      valB = b.balances?.annual.remaining ?? -1;
    } else {
      valA = a.balances?.sick.remaining ?? -1;
      valB = b.balances?.sick.remaining ?? -1;
    }
    if (valA < valB) return sortAsc ? -1 : 1;
    if (valA > valB) return sortAsc ? 1 : -1;
    return 0;
  });

  const SortIcon = ({ field }: { field: string }) =>
    sortField === field ? (
      sortAsc ? <ChevronUp size={14} /> : <ChevronDown size={14} />
    ) : null;

  // Summary totals
  const totalAnnualUsed = balances.reduce((s, b) => s + (b.balances?.annual.used ?? 0), 0);
  const totalAnnualAlloc = balances.reduce((s, b) => s + (b.balances?.annual.total ?? 0), 0);
  const totalSickUsed = balances.reduce((s, b) => s + (b.balances?.sick.used ?? 0), 0);
  const totalSickAlloc = balances.reduce((s, b) => s + (b.balances?.sick.total ?? 0), 0);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64" data-testid="ess-team-balances">
        <Loader2 className="animate-spin text-brand-primary" size={32} />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 md:p-6" data-testid="ess-team-balances">
      {/* Heading lives in TopHeader via usePageHeader — the back navigation stays here. */}
      <PageActionRow
        onBack={() => router.push('/dashboard/my-department')}
      />

      {/* Summary Cards */}
      {balances.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-surface-card rounded-[--radius-card] border border-surface-border shadow-sm p-5">
            <div className="flex items-center gap-2 mb-2">
              <Users size={16} className="text-brand-primary" />
              <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">Members</span>
            </div>
            <p data-testid="tb-stat" data-key="members" data-value={balances.length} className="text-2xl font-bold text-text-heading">{balances.length}</p>
          </div>
          <div className="bg-surface-card rounded-[--radius-card] border border-surface-border shadow-sm p-5">
            <div className="flex items-center gap-2 mb-2">
              <Calendar size={16} className="text-status-success" />
              <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">Annual Used</span>
            </div>
            <p data-testid="tb-stat" data-key="annualUsed" data-value={totalAnnualUsed} className="text-2xl font-bold text-text-heading">
              {totalAnnualUsed}
              <span className="text-sm text-text-muted font-normal">/{totalAnnualAlloc}d</span>
            </p>
          </div>
          <div className="bg-surface-card rounded-[--radius-card] border border-surface-border shadow-sm p-5">
            <div className="flex items-center gap-2 mb-2">
              <TrendingUp size={16} className="text-status-warning" />
              <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">Sick Used</span>
            </div>
            <p data-testid="tb-stat" data-key="sickUsed" data-value={totalSickUsed} className="text-2xl font-bold text-text-heading">
              {totalSickUsed}
              <span className="text-sm text-text-muted font-normal">/{totalSickAlloc}d</span>
            </p>
          </div>
          <div className="bg-surface-card rounded-[--radius-card] border border-surface-border shadow-sm p-5">
            <div className="flex items-center gap-2 mb-2">
              <AlertCircle size={16} className="text-status-error" />
              <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">No Balance</span>
            </div>
            <p
              data-testid="tb-stat"
              data-key="noBalance"
              data-value={balances.filter((b) => b.balances === null).length}
              className="text-2xl font-bold text-text-heading"
            >
              {balances.filter((b) => b.balances === null).length}
            </p>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div data-testid="tb-error" className="text-status-error text-sm bg-status-error-bg border border-status-error/20 rounded-[--radius-card] px-4 py-3 flex items-center gap-2">
          <AlertCircle size={16} />
          {error}
        </div>
      )}

      {/* Table */}
      <div className="bg-surface-card rounded-[--radius-card] border border-surface-border shadow-sm overflow-hidden">
        {/* Desktop table. D-15: five columns of balance pills had no scroll
            wrapper, so at 390px this ran off the side of the page. */}
        <table className="hidden w-full text-sm md:table">
          <thead className="bg-surface-page border-b border-surface-border">
            <tr>
              <th
                className="px-5 py-3 text-left font-semibold text-text-muted cursor-pointer hover:text-text-heading"
                data-testid="tb-sort-name"
                data-sort-active={sortField === 'fullName'}
                data-sort-dir={sortField === 'fullName' ? (sortAsc ? 'asc' : 'desc') : ''}
                onClick={() => toggleSort('fullName')}
              >
                <span className="flex items-center gap-1">Employee <SortIcon field="fullName" /></span>
              </th>
              <th className="px-5 py-3 text-left font-semibold text-text-muted">Position</th>
              <th
                className="px-5 py-3 text-left font-semibold text-text-muted cursor-pointer hover:text-text-heading"
                data-testid="tb-sort-annual"
                data-sort-active={sortField === 'annual'}
                data-sort-dir={sortField === 'annual' ? (sortAsc ? 'asc' : 'desc') : ''}
                onClick={() => toggleSort('annual')}
              >
                <span className="flex items-center gap-1">Annual Leave <SortIcon field="annual" /></span>
              </th>
              <th
                className="px-5 py-3 text-left font-semibold text-text-muted cursor-pointer hover:text-text-heading"
                data-testid="tb-sort-sick"
                data-sort-active={sortField === 'sick'}
                data-sort-dir={sortField === 'sick' ? (sortAsc ? 'asc' : 'desc') : ''}
                onClick={() => toggleSort('sick')}
              >
                <span className="flex items-center gap-1">Sick Leave <SortIcon field="sick" /></span>
              </th>
              <th className="px-5 py-3 text-left font-semibold text-text-muted">Carried Over</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border-light">
            {sorted.length === 0 ? (
              <tr>
                <td data-testid="tb-empty" colSpan={5} className="px-5 py-10 text-center text-text-muted">
                  No balance data found.
                </td>
              </tr>
            ) : (
              sorted.map((member) => (
                <tr
                  key={member.employeeId}
                  data-testid="tb-row"
                  data-employee-id={member.employeeId}
                  data-initialised={member.balances !== null}
                  data-annual-remaining={member.balances?.annual.remaining ?? ''}
                  data-annual-used={member.balances?.annual.used ?? ''}
                  data-annual-total={member.balances?.annual.total ?? ''}
                  data-sick-remaining={member.balances?.sick.remaining ?? ''}
                  data-carried={member.balances?.carriedOver ?? ''}
                  className="hover:bg-surface-page/50 transition-colors"
                >
                  <td className="px-5 py-4">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-full bg-gradient-to-br from-brand-primary-light to-brand-primary text-text-on-brand flex items-center justify-center font-bold text-sm shrink-0">
                        {member.fullName?.charAt(0)}
                      </div>
                      <div>
                        <p className="font-semibold text-text-body">{member.fullName}</p>
                        <p className="text-xs text-text-muted font-mono">{member.employeeCode}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-4 text-text-muted text-sm">{member.position}</td>
                  <td className="px-5 py-4 min-w-[140px]">
                    {member.balances ? (
                      <BalancePill
                        label={`${member.balances.annual.remaining}d left`}
                        used={member.balances.annual.used}
                        total={member.balances.annual.total}
                        color="bg-status-success"
                      />
                    ) : (
                      <span className="text-xs text-text-muted italic">Not initialized</span>
                    )}
                  </td>
                  <td className="px-5 py-4 min-w-[140px]">
                    {member.balances ? (
                      <BalancePill
                        label={`${member.balances.sick.remaining}d left`}
                        used={member.balances.sick.used}
                        total={member.balances.sick.total}
                        color="bg-brand-primary"
                      />
                    ) : (
                      <span className="text-xs text-text-muted italic">Not initialized</span>
                    )}
                  </td>
                  <td className="px-5 py-4">
                    {member.balances ? (
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-status-warning-bg text-status-warning">
                        +{member.balances.carriedOver}d
                      </span>
                    ) : (
                      <span className="text-text-muted/40">—</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        {/* Mobile cards */}
        <div className="md:hidden p-4 space-y-3">
          {sorted.length === 0 ? (
            <EmptyState icon={Users} title="No balance data found." testId="tb-empty-card" />
          ) : (
            sorted.map((member) => (
              <DataCard
                key={`m-${member.employeeId}`}
                testId="tb-card"
                title={
                  <span className="flex items-center gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-primary-light to-brand-primary text-sm font-bold text-text-on-brand">
                      {member.fullName?.charAt(0)}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate">{member.fullName}</span>
                      <span className="block truncate font-mono text-xs font-normal text-text-muted">
                        {member.employeeCode}
                      </span>
                    </span>
                  </span>
                }
                items={[
                  { label: 'Position', value: member.position || '—' },
                  { label: 'Carried over', value: member.balances ? `${member.balances.carriedOver}d` : '—' },
                  {
                    label: 'Annual leave',
                    full: true,
                    value: member.balances ? (
                      <BalancePill
                        label={`${member.balances.annual.remaining}d left`}
                        used={member.balances.annual.used}
                        total={member.balances.annual.total}
                        color="bg-status-success"
                      />
                    ) : (
                      'Not initialised'
                    ),
                  },
                  {
                    label: 'Sick leave',
                    full: true,
                    value: member.balances ? (
                      <BalancePill
                        label={`${member.balances.sick.remaining}d left`}
                        used={member.balances.sick.used}
                        total={member.balances.sick.total}
                        color="bg-status-info"
                      />
                    ) : (
                      'Not initialised'
                    ),
                  },
                ]}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

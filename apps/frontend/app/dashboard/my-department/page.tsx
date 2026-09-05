'use client';

import { useEffect, useState } from 'react';
import { useAuthStore } from '@/store/authStore';
import { useRouter } from 'next/navigation';
import employeeService from '@/services/employeeService';
import {
  Users, TrendingUp, Calendar, Loader2, BarChart3, ChevronRight, Search
} from 'lucide-react';
import Link from 'next/link';
import PageActionRow from '@/components/common/PageActionRow';
import DataCard from '@/components/common/DataCard';
import EmptyState from '@/components/common/EmptyState';
import { usePageHeader } from '@/hooks/usePageHeader';

interface TeamMember {
  id: string;
  employeeCode: string;
  fullName: string;
  position: string;
  email: string;
  phone?: string;
  avatarUrl?: string;
  status: string;
}

interface DeptStat {
  label: string;
  value: string | number;
  icon: any;
  color: string;
  bg: string;
}

export default function MyDepartmentPage() {
  const { user } = useAuthStore();
  const router = useRouter();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [filtered, setFiltered] = useState<TeamMember[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // The one heading for this route, rendered by TopHeader. Declared above the
  // loading early-return so the hook order never changes between renders.
  usePageHeader('My Department', 'Manage and monitor your team members');

  useEffect(() => {
    if (user?.role !== 'MANAGER') {
      router.replace('/dashboard');
      return;
    }
    fetchTeam();
  }, [user]);

  const fetchTeam = async () => {
    try {
      setLoading(true);
      const res = await employeeService.getAll({ limit: 200 });
      const data: TeamMember[] = (res as any)?.data?.data ?? (res as any)?.data ?? [];
      setMembers(data);
      setFiltered(data);
    } catch (e: any) {
      setError(e?.response?.data?.message || 'Failed to load team members');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!search.trim()) {
      setFiltered(members);
    } else {
      const q = search.toLowerCase();
      setFiltered(
        members.filter(
          (m) =>
            m.fullName?.toLowerCase().includes(q) ||
            m.position?.toLowerCase().includes(q) ||
            m.employeeCode?.toLowerCase().includes(q),
        ),
      );
    }
  }, [search, members]);

  const activeCount = members.filter((m) => m.status === 'ACTIVE').length;

  const stats: DeptStat[] = [
    { label: 'Total Members', value: members.length, icon: Users, color: 'text-brand-primary', bg: 'bg-brand-primary-light/40' },
    { label: 'Active', value: activeCount, icon: TrendingUp, color: 'text-status-success', bg: 'bg-status-success-bg' },
    { label: 'On Leave', value: members.filter((m) => m.status === 'ON_LEAVE').length, icon: Calendar, color: 'text-status-warning', bg: 'bg-status-warning-bg' },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64" data-testid="ess-my-department">
        <Loader2 className="animate-spin text-brand-primary" size={32} />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 md:p-6" data-testid="ess-my-department">
      {/* Heading lives in TopHeader via usePageHeader — only the action stays here.
          The decorative Building2 icon belonged to the old heading and went with it. */}
      <PageActionRow
        action={
          <Link
            href="/dashboard/my-department/team-balances"
            className="flex items-center gap-2 bg-brand-primary hover:bg-brand-primary-dark text-text-on-brand text-sm font-semibold px-4 py-2 rounded-[--radius-button] transition-colors"
          >
            <BarChart3 size={16} />
            Team Balances
          </Link>
        }
      />

      {/* Stats */}
      {/* `grid-cols-3` with no mobile variant gave each tile ~110px. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {stats.map((s) => (
          <div key={s.label} className="bg-surface-card rounded-[--radius-card] border border-surface-border shadow-sm p-5 flex items-center gap-4">
            <div className={`w-11 h-11 rounded-[--radius-card] ${s.bg} flex items-center justify-center`}>
              <s.icon size={20} className={s.color} />
            </div>
            <div>
              <p className="text-2xl font-bold text-text-heading">{s.value}</p>
              <p className="text-xs text-text-muted font-medium">{s.label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Search */}
      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, position, or employee code…"
          className="w-full pl-9 pr-4 py-2.5 text-sm border border-surface-border rounded-[--radius-input] focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary bg-surface-card text-text-body placeholder:text-text-muted/60"
        />
      </div>

      {/* Member Table */}
      <div className="bg-surface-card rounded-[--radius-card] border border-surface-border shadow-sm overflow-hidden">
        {/* Desktop table. D-15: this used to be the only view, with no scroll
            wrapper at all, so at 390px it ran off the side of the page. */}
        <table className="hidden w-full text-sm md:table">
          <thead className="bg-surface-page border-b border-surface-border">
            <tr>
              <th className="px-5 py-3 text-left font-semibold text-text-muted">Employee</th>
              <th className="px-5 py-3 text-left font-semibold text-text-muted">Position</th>
              <th className="px-5 py-3 text-left font-semibold text-text-muted">Status</th>
              <th className="px-5 py-3 text-left font-semibold text-text-muted">Code</th>
              <th className="px-5 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border-light">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-5 py-10 text-center text-text-muted">
                  {search ? 'No members match your search.' : 'No team members found.'}
                </td>
              </tr>
            ) : (
              filtered.map((m) => (
                <tr key={m.id} className="hover:bg-surface-page/50 transition-colors">
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-full bg-gradient-to-br from-brand-primary-light to-brand-primary text-text-on-brand flex items-center justify-center font-bold text-sm shrink-0">
                        {m.fullName?.charAt(0)}
                      </div>
                      <div>
                        <p className="font-semibold text-text-body">{m.fullName}</p>
                        <p className="text-xs text-text-muted">{m.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3.5 text-text-body">{m.position}</td>
                  <td className="px-5 py-3.5">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold
                      ${m.status === 'ACTIVE' ? 'bg-status-success-bg text-status-success' :
                        m.status === 'ON_LEAVE' ? 'bg-status-warning-bg text-status-warning' :
                        'bg-surface-page text-text-muted border border-surface-border' /* neutral */}`}>
                      {m.status}
                    </span>
                  </td>
                  <td className="px-5 py-3.5 font-mono text-xs text-text-muted">{m.employeeCode}</td>
                  <td className="px-5 py-3.5 text-right">
                    <Link
                      href={`/dashboard/employees/${m.id}`}
                      className="inline-flex items-center gap-1 text-brand-primary hover:text-brand-primary-dark text-xs font-medium"
                    >
                      View <ChevronRight size={14} />
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        {/* Mobile cards */}
        <div className="md:hidden p-4 space-y-3">
          {filtered.length === 0 ? (
            <EmptyState
              icon={Users}
              title={search ? 'No members match your search.' : 'No team members found.'}
              action={search ? { label: 'Clear search', onClick: () => setSearch(''), testId: 'dept-empty-clear' } : undefined}
              testId="dept-member-empty-card"
            />
          ) : (
            filtered.map((m) => (
              <DataCard
                key={`m-${m.id}`}
                testId="dept-member-card"
                onClick={() => router.push(`/dashboard/employees/${m.id}`)}
                title={
                  <span className="flex items-center gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-primary-light to-brand-primary text-sm font-bold text-text-on-brand">
                      {m.fullName?.charAt(0)}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate">{m.fullName}</span>
                      <span className="block truncate text-xs font-normal text-text-muted">{m.email}</span>
                    </span>
                  </span>
                }
                headerRight={
                  <span
                    className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                      m.status === 'ACTIVE'
                        ? 'bg-status-success-bg text-status-success'
                        : m.status === 'ON_LEAVE'
                          ? 'bg-status-warning-bg text-status-warning'
                          : 'bg-surface-page text-text-muted border border-surface-border'
                    }`}
                  >
                    {m.status}
                  </span>
                }
                items={[
                  { label: 'Position', value: m.position || '—' },
                  { label: 'Code', value: <span className="font-mono text-xs">{m.employeeCode}</span> },
                ]}
              />
            ))
          )}
        </div>
      </div>

      {error && (
        <div className="text-status-error text-sm bg-status-error-bg border border-status-error/20 rounded-[--radius-card] px-4 py-3">{error}</div>
      )}
    </div>
  );
}

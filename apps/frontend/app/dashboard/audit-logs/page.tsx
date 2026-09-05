'use client';

import React, { useState, useEffect } from 'react';
import { getCompanyTz } from '@/utils/formatters';
import axiosInstance from '@/lib/axios';
import { toast } from '@/lib/toast';
import { usePageHeader } from '@/hooks/usePageHeader';
import PageActionRow from '@/components/common/PageActionRow';
import {
  Search,
  Calendar,
  Filter,
  Download,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Server,
  Activity,
  ChevronDown,
  ChevronUp,
  PlusCircle,
  ArrowRight,
  Trash2,
  Pencil
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface AuditLogEntry {
  id: string;
  userId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  oldData: any;
  newData: any;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  user: {
    id: string;
    email: string;
    role: string;
    employee?: {
      fullName: string;
    };
  } | null;
}

// Normalise IPv6 loopback / IPv4-mapped addresses stored before the backend fix
const normalizeIp = (ip: string | null) => {
  if (!ip) return '127.0.0.1';
  if (ip === '::1') return '127.0.0.1';
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  return ip;
};

// ─── Diff helpers ────────────────────────────────────────────────────────────

const SKIP_KEYS = new Set([
  'id', 'createdAt', 'updatedAt', 'deletedAt', 'companyId', 'password',
]);

const formatFieldLabel = (key: string) =>
  key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();

const formatFieldValue = (val: any): string => {
  if (val === null || val === undefined) return '—';
  if (typeof val === 'boolean') return val ? 'Yes' : 'No';
  if (typeof val === 'string') {
    if (val === '') return '—';
    if (/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/.test(val)) {
      try {
        return new Date(val).toLocaleString('en-IN', {
          timeZone: getCompanyTz(), dateStyle: 'medium', timeStyle: 'short',
        });
      } catch { return val; }
    }
    return val;
  }
  if (typeof val === 'number') return String(val);
  if (Array.isArray(val)) return val.length ? `${val.length} item(s)` : '—';
  if (typeof val === 'object') {
    if (val.taskCode) return val.title ? `${val.taskCode} — ${val.title}` : val.taskCode;
    if (val.name) return val.name;
    if (val.fullName) return val.fullName;
    if (val.title) return val.title;
    if (val.email) return val.email;
    if (val.code) return val.code;
    for (const [k, v] of Object.entries(val)) {
      if (k !== 'id' && typeof v === 'string' && v) return v;
    }
    return '—';
  }
  return String(val);
};

const flattenForDisplay = (obj: any) =>
  Object.entries(obj ?? {})
    .filter(([k]) => !SKIP_KEYS.has(k) && !k.endsWith('Id'))
    .map(([k, v]) => ({ key: k, label: formatFieldLabel(k), value: formatFieldValue(v) }));

const computeChangedFields = (oldObj: any, newObj: any) => {
  const keys = new Set([
    ...Object.keys(oldObj ?? {}),
    ...Object.keys(newObj ?? {}),
  ]);
  return [...keys]
    .filter(k => !SKIP_KEYS.has(k) && !k.endsWith('Id'))
    .map(k => ({
      key: k,
      label: formatFieldLabel(k),
      before: formatFieldValue((oldObj ?? {})[k]),
      after: formatFieldValue((newObj ?? {})[k]),
    }))
    .filter(d => d.before !== d.after);
};

// How many rows one CSV export may carry. The server pages this endpoint, so
// an export is a single capped page — stated on screen next to the button
// because an audit export that silently stops at 1,000 rows and still looks
// complete is the dangerous failure, not the loud one.
const EXPORT_ROW_LIMIT = 1000;

// ─────────────────────────────────────────────────────────────────────────────

export default function AuditLogsPage() {
  // The one heading for this route, rendered by TopHeader.
  usePageHeader('System Audit Logs', 'Monitor all system actions, creates, updates and deletes in real-time.');

  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [resourceTypes, setResourceTypes] = useState<string[]>([]);
  // Actions seen in the data. The filter used to offer a hard-coded
  // CREATE/UPDATE/DELETE while the interceptor also writes domain verbs
  // (TRAINING_APPROVED, TRAINING_NOMINATED, CLEARANCE_OVERRIDDEN, …), so most
  // of the log could not be filtered for at all. Seeded from /audit-logs/stats
  // (an aggregate over the whole window, not just this page) and then widened
  // by every page fetched — there is no distinct-actions endpoint to ask.
  const [actionOptions, setActionOptions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  // Filters
  const [search, setSearch] = useState('');
  const [resourceType, setResourceType] = useState('');
  const [action, setAction] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // Pagination
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

  // Expanded Log Details (for Diff)
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);

  // Merge newly seen actions into the filter's option list. Union, never
  // replace: paging away from a page must not remove the option it revealed.
  const rememberActions = (seen: (string | null | undefined)[]) => {
    setActionOptions(prev => {
      const merged = new Set(prev);
      for (const a of seen) if (a) merged.add(a);
      return merged.size === prev.length ? prev : [...merged].sort();
    });
  };

  // Fetch unique resource types logged in DB
  const fetchResourceTypes = async () => {
    try {
      const res: any = await axiosInstance.get('/audit-logs/resources');
      if (res?.success) {
        setResourceTypes(res.data);
      }
    } catch (err: any) {
      console.error('Failed to fetch resource types:', err);
    }
  };

  // Seed the Action filter from the aggregate rather than from page 1's twenty
  // rows. 720h is the largest window the endpoint accepts.
  const fetchActionVocabulary = async () => {
    try {
      const res: any = await axiosInstance.get('/audit-logs/stats', { params: { hours: 720 } });
      rememberActions((res?.data?.byAction || []).map((r: any) => r?.action));
    } catch (err: any) {
      // Non-fatal: the list still fills in from the rows themselves below.
      console.error('Failed to fetch audit action stats:', err);
    }
  };

  // Fetch main audit log list
  const fetchLogs = async (currentPage = page) => {
    setLoading(true);
    try {
      const params: any = {
        page: currentPage,
        limit,
      };

      if (search.trim()) params.search = search.trim();
      if (resourceType) params.resourceType = resourceType;
      if (action) params.action = action;
      if (dateFrom) params.dateFrom = new Date(dateFrom).toISOString();
      if (dateTo) params.dateTo = new Date(dateTo).toISOString();

      const res: any = await axiosInstance.get('/audit-logs', { params });
      if (res?.success) {
        setLogs(res.data);
        setTotal(res.meta.total);
        setTotalPages(res.meta.totalPages);
        rememberActions((res.data || []).map((l: AuditLogEntry) => l.action));
      }
    } catch (err: any) {
      toast.error(err?.response?.data?.message || err?.message || 'Failed to load audit logs');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchResourceTypes();
    fetchActionVocabulary();
  }, []);

  useEffect(() => {
    fetchLogs(page);
  }, [page, limit, resourceType, action, dateFrom, dateTo]);

  // Handler for manual refresh or search submit
  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    fetchLogs(1);
  };

  // Clear all filters
  const handleClearFilters = () => {
    setSearch('');
    setResourceType('');
    setAction('');
    setDateFrom('');
    setDateTo('');
    setPage(1);
  };

  // Export visible/filtered logs as CSV
  const handleExportCSV = async () => {
    setExporting(true);
    try {
      // Fetch larger set of logs matches current filters for export (one capped page)
      const params: any = {
        page: 1,
        limit: EXPORT_ROW_LIMIT,
      };
      if (search.trim()) params.search = search.trim();
      if (resourceType) params.resourceType = resourceType;
      if (action) params.action = action;
      if (dateFrom) params.dateFrom = new Date(dateFrom).toISOString();
      if (dateTo) params.dateTo = new Date(dateTo).toISOString();

      const res: any = await axiosInstance.get('/audit-logs', { params });
      const exportLogs: AuditLogEntry[] = res?.data || [];
      // What the filter actually matches, which is what the cap is measured
      // against — `exportLogs.length` alone cannot tell truncation from a
      // filter that happens to match exactly the cap.
      const matching: number = res?.meta?.total ?? exportLogs.length;

      if (exportLogs.length === 0) {
        toast.warning('No records found matching filters to export');
        return;
      }

      const headers = ['Timestamp', 'Performed By', 'Role', 'Action', 'Resource Type', 'Resource ID', 'IP Address', 'User Agent'];
      const csvContent = [
        headers.join(','),
        ...exportLogs.map(log => {
          const userMail = log.user ? log.user.email : 'System/API';
          const userRole = log.user ? log.user.role : 'System';
          const ip = log.ipAddress || 'N/A';
          const agent = log.userAgent ? `"${log.userAgent.replace(/"/g, '""')}"` : 'N/A';
          return [
            new Date(log.createdAt).toISOString(),
            userMail,
            userRole,
            log.action,
            log.resourceType,
            log.resourceId || 'N/A',
            ip,
            agent
          ].join(',');
        })
      ].join('\n');

      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', `audit_logs_${new Date().toISOString().split('T')[0]}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      // Never report a truncated audit export as a clean one.
      if (matching > exportLogs.length) {
        toast.warning(
          `Exported the first ${exportLogs.length.toLocaleString()} of ${matching.toLocaleString()} matching logs — exports are capped at ${EXPORT_ROW_LIMIT.toLocaleString()} rows. Narrow the date range or filters to export the rest.`,
        );
      } else {
        toast.success(`Exported ${exportLogs.length} audit logs successfully!`);
      }
    } catch (err: any) {
      toast.error('Failed to export CSV');
    } finally {
      setExporting(false);
    }
  };

  const getActionBadgeColor = (act: string) => {
    switch (act.toUpperCase()) {
      case 'CREATE':
        return 'bg-status-success-bg text-status-success border-status-success/20';
      case 'UPDATE':
        return 'bg-status-warning-bg text-status-warning border-status-warning/20';
      case 'DELETE':
        return 'bg-status-error-bg text-status-error border-status-error/20';
      default:
        return 'bg-surface-page text-text-muted border-surface-border';
    }
  };

  return (
    <div className="space-y-6 max-w-full p-4 lg:p-6 font-sans text-text-body">
      {/* Actions only — the title/subtitle live in the sticky TopHeader,
          declared via usePageHeader above. */}
      <PageActionRow
        action={
          <>
            <button
              onClick={() => fetchLogs(1)}
              disabled={loading}
              className="flex items-center gap-2 px-4 py-2.5 border border-surface-border text-text-body bg-surface-card rounded-[--radius-button] hover:bg-surface-page font-semibold transition-colors disabled:opacity-50"
              title="Refresh Logs"
            >
              <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
              <span>Refresh</span>
            </button>
            <span
              data-testid="audit-export-limit"
              className={`self-center text-xs ${total > EXPORT_ROW_LIMIT ? 'font-semibold text-status-warning' : 'text-text-muted'}`}
            >
              {total > EXPORT_ROW_LIMIT
                ? `Export capped at ${EXPORT_ROW_LIMIT.toLocaleString()} of ${total.toLocaleString()} matching rows`
                : `Exports up to ${EXPORT_ROW_LIMIT.toLocaleString()} rows`}
            </span>
            <button
              onClick={handleExportCSV}
              disabled={exporting || logs.length === 0}
              className="flex items-center gap-2 px-4 py-2.5 bg-brand-primary text-text-on-brand rounded-[--radius-button] hover:bg-brand-primary-dark font-semibold shadow-md transition-all disabled:opacity-50"
            >
              <Download size={18} />
              <span>{exporting ? 'Exporting...' : 'Export CSV'}</span>
            </button>
          </>
        }
      />

      {/* Filter and search bar */}
      <form onSubmit={handleSearchSubmit} className="bg-surface-card p-6 rounded-[--radius-card] border border-surface-border shadow-xs space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
          {/* Search field */}
          <div className="lg:col-span-2 relative">
            <label className="block text-xs font-bold text-text-muted uppercase tracking-wider mb-1">Search Context</label>
            <div className="relative">
              <Search size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-text-muted" />
              <input
                type="text"
                placeholder="User email, IP, agent, resource ID..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 bg-surface-page border border-surface-border rounded-[--radius-input] focus:bg-surface-card focus:border-brand-primary focus:ring-4 focus:ring-brand-primary/10 transition-all outline-none text-sm text-text-body placeholder:text-text-muted/60"
              />
            </div>
          </div>

          {/* Resource Type filter */}
          <div>
            <label className="block text-xs font-bold text-text-muted uppercase tracking-wider mb-1">Resource Type</label>
            <div className="relative">
              <select
                value={resourceType}
                onChange={(e) => setResourceType(e.target.value)}
                className="w-full px-3 py-2.5 bg-surface-page border border-surface-border rounded-[--radius-input] focus:bg-surface-card focus:border-brand-primary transition-all outline-none text-sm text-text-body appearance-none cursor-pointer"
              >
                <option value="">All Resources</option>
                {resourceTypes.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
              <Filter size={16} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
            </div>
          </div>

          {/* Action filter */}
          <div>
            <label className="block text-xs font-bold text-text-muted uppercase tracking-wider mb-1">Action</label>
            <div className="relative">
              <select
                value={action}
                onChange={(e) => setAction(e.target.value)}
                className="w-full px-3 py-2.5 bg-surface-page border border-surface-border rounded-[--radius-input] focus:bg-surface-card focus:border-brand-primary transition-all outline-none text-sm text-text-body appearance-none cursor-pointer"
              >
                <option value="">All Actions</option>
                {/* The active selection is force-included: a filter that
                    returns nothing must not blank out its own <select>. */}
                {[...new Set(action ? [...actionOptions, action] : actionOptions)]
                  .sort()
                  .map((act) => (
                    <option key={act} value={act}>
                      {act}
                    </option>
                  ))}
              </select>
              <Activity size={16} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
            </div>
          </div>

          {/* Submit & Reset buttons */}
          <div className="flex items-end gap-2">
            <button
              type="submit"
              className="flex-1 py-2.5 bg-brand-primary text-text-on-brand hover:bg-brand-primary-dark rounded-[--radius-button] font-semibold text-sm transition-colors shadow-sm cursor-pointer"
            >
              Apply Filter
            </button>
            <button
              type="button"
              onClick={handleClearFilters}
              className="px-3 py-2.5 border border-surface-border text-text-muted hover:text-text-body bg-surface-card rounded-[--radius-button] hover:bg-surface-page font-semibold text-sm transition-all"
            >
              Clear
            </button>
          </div>
        </div>

        {/* Date Filters */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 border-t border-surface-border pt-4">
          <div className="relative">
            <label className="block text-xs font-bold text-text-muted uppercase tracking-wider mb-1">Date Range Start</label>
            <div className="relative">
              <input
                type="datetime-local"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 bg-surface-page border border-surface-border rounded-[--radius-input] focus:bg-surface-card focus:border-brand-primary transition-all outline-none text-sm text-text-body"
              />
              <Calendar size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
            </div>
          </div>
          <div className="relative">
            <label className="block text-xs font-bold text-text-muted uppercase tracking-wider mb-1">Date Range End</label>
            <div className="relative">
              <input
                type="datetime-local"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 bg-surface-page border border-surface-border rounded-[--radius-input] focus:bg-surface-card focus:border-brand-primary transition-all outline-none text-sm text-text-body"
              />
              <Calendar size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
            </div>
          </div>
        </div>
      </form>

      {/* Main Table view */}
      <div className="bg-surface-card rounded-[--radius-card] border border-surface-border shadow-xs overflow-hidden">
        {loading ? (
          <div className="py-24 flex flex-col items-center justify-center gap-4">
            <div className="w-12 h-12 border-4 border-brand-primary-light border-t-brand-primary rounded-full animate-spin"></div>
            <span className="text-text-muted font-semibold text-sm">Fetching system activity logs...</span>
          </div>
        ) : logs.length === 0 ? (
          <div className="py-20 flex flex-col items-center justify-center text-center p-6">
            <div className="w-16 h-16 bg-surface-page border border-surface-border rounded-[--radius-card] flex items-center justify-center text-text-muted mb-4 shadow-inner">
              <Server size={32} />
            </div>
            <h3 className="text-lg font-bold text-text-heading mb-1">No log entries found</h3>
            <p className="text-text-muted text-sm max-w-md">No system events matched the selected filters. Try broadening your query or clearing date constraints.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="bg-surface-page border-b border-surface-border text-text-muted text-xs font-bold uppercase tracking-wider select-none">
                  <th className="py-4 px-6">Timestamp</th>
                  <th className="py-4 px-6">User / Actor</th>
                  <th className="py-4 px-6 text-center">Action</th>
                  <th className="py-4 px-6">Resource Type</th>
                  <th className="py-4 px-6">Resource ID</th>
                  <th className="py-4 px-6">Network details</th>
                  <th className="py-4 px-6 text-center">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border-light text-sm">
                {logs.map((log) => {
                  const isExpanded = expandedLogId === log.id;
                  const formattedTime = new Date(log.createdAt).toLocaleString('en-IN', {
                    timeZone: getCompanyTz(),
                    dateStyle: 'medium',
                    timeStyle: 'medium'
                  });

                  return (
                    <React.Fragment key={log.id}>
                      <tr className={`hover:bg-surface-page/50 transition-colors ${isExpanded ? 'bg-surface-page/30' : ''}`}>
                        {/* Time */}
                        <td className="py-4.5 px-6 text-text-muted font-medium whitespace-nowrap">
                          {formattedTime}
                        </td>
                        {/* Actor User */}
                        <td className="py-4.5 px-6 font-semibold text-text-heading">
                          {log.user ? (
                            <div className="flex flex-col">
                              <span className="text-[13px] text-text-body leading-normal">{log.user.email}</span>
                              <span className="text-[10px] text-text-muted uppercase tracking-wider font-bold">{log.user.role}</span>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1.5 text-text-muted font-medium">
                              <Server size={14} />
                              <span className="text-xs">System API</span>
                            </div>
                          )}
                        </td>
                        {/* Action badge */}
                        <td className="py-4.5 px-6 text-center whitespace-nowrap">
                          <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-bold border ${getActionBadgeColor(log.action)}`}>
                            {log.action}
                          </span>
                        </td>
                        {/* Resource type */}
                        <td className="py-4.5 px-6 font-bold text-text-body whitespace-nowrap">
                          {log.resourceType}
                        </td>
                        {/* Resource uuid */}
                        <td className="py-4.5 px-6 font-mono text-xs text-text-muted select-all max-w-[120px] truncate" title={log.resourceId || 'N/A'}>
                          {log.resourceId || '—'}
                        </td>
                        {/* IP and Agent info */}
                        <td className="py-4.5 px-6 text-xs text-text-muted">
                          <div className="flex flex-col gap-0.5">
                            <span className="font-semibold text-text-body">{normalizeIp(log.ipAddress)}</span>
                            <span className="truncate max-w-[160px] text-text-muted/65" title={log.userAgent || 'Unknown System'}>
                              {log.userAgent || 'Unknown Agent'}
                            </span>
                          </div>
                        </td>
                        {/* Expand toggle */}
                        <td className="py-4.5 px-6 text-center">
                          <button
                            onClick={() => setExpandedLogId(isExpanded ? null : log.id)}
                            className="p-1.5 rounded-[--radius-button] hover:bg-surface-page text-text-muted hover:text-text-heading transition-colors inline-flex items-center justify-center"
                          >
                            {isExpanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                          </button>
                        </td>
                      </tr>

                      {/* Expandable diff pane */}
                      {isExpanded && (
                        <tr>
                          <td colSpan={7} className="p-0 bg-surface-page/35">
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: 'auto', opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              className="border-t border-b border-surface-border p-6 space-y-4"
                            >
                              {/* ── CREATE ─────────────────────────────────── */}
                              {log.action === 'CREATE' && (() => {
                                const fields = flattenForDisplay(log.newData);
                                return (
                                  <div className="space-y-3">
                                    <div className="flex items-center gap-2">
                                      <PlusCircle size={16} className="text-status-success" />
                                      <span className="font-bold text-status-success text-sm">
                                        New {log.resourceType} was created
                                      </span>
                                    </div>
                                    {fields.length === 0 ? (
                                      <p className="text-text-muted text-sm">No field data recorded.</p>
                                    ) : (
                                      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                                        {fields.map(({ key, label, value }) => (
                                          <div key={key} className="bg-surface-card border border-status-success/20 rounded-[--radius-card] p-3">
                                            <div className="text-[10px] font-bold text-text-muted uppercase tracking-wider mb-1">{label}</div>
                                            <div className="text-sm text-text-body font-medium break-words">{value}</div>
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                );
                              })()}

                              {/* ── UPDATE ─────────────────────────────────── */}
                              {log.action === 'UPDATE' && (() => {
                                const changes = computeChangedFields(log.oldData, log.newData);
                                return (
                                  <div className="space-y-3">
                                    <div className="flex items-center gap-2">
                                      <Pencil size={15} className="text-status-warning" />
                                      <span className="font-bold text-status-warning text-sm">
                                        {changes.length > 0
                                          ? `${changes.length} field${changes.length > 1 ? 's' : ''} updated`
                                          : 'Record updated'}
                                      </span>
                                    </div>
                                    {changes.length === 0 ? (
                                      <p className="text-text-muted text-sm">No visible field changes recorded.</p>
                                    ) : (
                                      <div className="rounded-[--radius-card] border border-surface-border overflow-hidden">
                                        {/* Header row */}
                                        <div className="grid grid-cols-[180px_1fr_40px_1fr] gap-0 bg-surface-page border-b border-surface-border px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-text-muted">
                                          <span>Field</span>
                                          <span>Before</span>
                                          <span />
                                          <span>After</span>
                                        </div>
                                        {changes.map(({ key, label, before, after }, idx) => (
                                          <div
                                            key={key}
                                            className={`grid grid-cols-[180px_1fr_40px_1fr] gap-0 px-4 py-3 text-sm items-center ${idx % 2 === 0 ? 'bg-surface-card' : 'bg-surface-page/40'}`}
                                          >
                                            <span className="font-semibold text-text-muted text-xs">{label}</span>
                                            <span className="text-status-error bg-status-error-bg/30 px-2 py-0.5 rounded text-xs font-medium break-words line-through decoration-status-error/50">
                                              {before}
                                            </span>
                                            <span className="flex justify-center">
                                              <ArrowRight size={14} className="text-text-muted" />
                                            </span>
                                            <span className="text-status-success bg-status-success-bg/30 px-2 py-0.5 rounded text-xs font-medium break-words">
                                              {after}
                                            </span>
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                );
                              })()}

                              {/* ── DELETE ─────────────────────────────────── */}
                              {log.action === 'DELETE' && (() => {
                                const fields = flattenForDisplay(log.oldData);
                                return (
                                  <div className="space-y-3">
                                    <div className="flex items-center gap-2">
                                      <Trash2 size={15} className="text-status-error" />
                                      <span className="font-bold text-status-error text-sm">
                                        {log.resourceType} was permanently deleted
                                      </span>
                                    </div>
                                    {fields.length === 0 ? (
                                      <p className="text-text-muted text-sm">No field data recorded before deletion.</p>
                                    ) : (
                                      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                                        {fields.map(({ key, label, value }) => (
                                          <div key={key} className="bg-surface-card border border-status-error/20 rounded-[--radius-card] p-3 opacity-80">
                                            <div className="text-[10px] font-bold text-text-muted uppercase tracking-wider mb-1">{label}</div>
                                            <div className="text-sm text-text-body font-medium break-words line-through decoration-text-muted/40">{value}</div>
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                );
                              })()}

                              {/* ── Other actions ──────────────────────────── */}
                              {!['CREATE', 'UPDATE', 'DELETE'].includes(log.action) && (
                                <p className="text-text-muted text-sm">No change details available for this action.</p>
                              )}
                            </motion.div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination controls */}
        {!loading && logs.length > 0 && (
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4 p-6 bg-surface-page/50 border-t border-surface-border">
            <span className="text-xs text-text-muted font-bold tracking-wider uppercase">
              Showing page {page} of {totalPages} ({total} entries total)
            </span>
            <div className="flex items-center gap-3">
              {/* Row limit selector */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-text-muted font-bold uppercase">Rows per page:</span>
                <select
                  value={limit}
                  onChange={(e) => {
                    setLimit(Number(e.target.value));
                    setPage(1);
                  }}
                  className="bg-surface-card border border-surface-border rounded-[--radius-button] px-2 py-1 text-xs text-text-body outline-none cursor-pointer"
                >
                  <option value={10}>10</option>
                  <option value={20}>20</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                </select>
              </div>

              {/* Prev / Next buttons */}
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setPage(prev => Math.max(prev - 1, 1))}
                  disabled={page === 1}
                  className="p-2 border border-surface-border rounded-[--radius-button] hover:bg-surface-page hover:text-text-heading disabled:opacity-40 transition-colors"
                >
                  <ChevronLeft size={16} />
                </button>
                <button
                  onClick={() => setPage(prev => Math.min(prev + 1, totalPages))}
                  disabled={page === totalPages}
                  className="p-2 border border-surface-border rounded-[--radius-button] hover:bg-surface-page hover:text-text-heading disabled:opacity-40 transition-colors"
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Search, CheckCircle, AlertTriangle, XCircle, RefreshCw } from 'lucide-react';
import * as XLSX from 'xlsx';
import visaService from '@/services/visaService';
import libraryService from '@/services/libraryService';
import {
  VisaRecord,
  VisaSummary,
  VisaStatus,
  VISA_STATUS_LABEL_KEYS,
  VISA_STATUS_CLASSES,
  VISA_EXPIRING_SOON_CLASS,
} from '@/types/visa';
import { formatDate } from '@/utils/formatters';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import Pagination from '@/components/common/Pagination';
import ExportButton from '@/components/common/ExportButton';
import PageActionRow from '@/components/common/PageActionRow';
import { usePageHeader } from '@/hooks/usePageHeader';

const LIMIT_DEFAULT = 20;

function VisaReportsContent() {
  const t = useTranslations('visas');
  const router = useRouter();

  // The one heading for this route, rendered by TopHeader.
  usePageHeader(t('reportsTitle'), t('reportsSubtitle'));

  const [visas, setVisas] = useState<VisaRecord[]>([]);
  const [summary, setSummary] = useState<VisaSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [visaTypes, setVisaTypes] = useState<string[]>([]);

  // Filters
  const [status, setStatus] = useState('');
  const [country, setCountry] = useState('');
  const [documentType, setDocumentType] = useState('');
  const [expiringInDays, setExpiringInDays] = useState('');
  const [search, setSearch] = useState('');

  // Pagination
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(LIMIT_DEFAULT);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

  const fetchSummary = useCallback(async () => {
    try {
      const res = await visaService.getSummary();
      if (res?.success) setSummary(res.data);
    } catch (error) {
      console.error('Failed to fetch visa summary:', error);
    }
  }, []);

  const fetchVisas = useCallback(async () => {
    try {
      setLoading(true);
      const res = await visaService.getAll({
        status: status || undefined,
        country: country || undefined,
        documentType: documentType || undefined,
        expiringInDays: expiringInDays ? Number(expiringInDays) : undefined,
        search: search || undefined,
        page,
        limit,
      });
      if (res?.success) {
        setVisas(res.data || []);
        setTotal(res.meta?.total || 0);
        setTotalPages(res.meta?.totalPages || 1);
      }
    } catch (error) {
      console.error('Failed to fetch visas:', error);
    } finally {
      setLoading(false);
    }
  }, [status, country, documentType, expiringInDays, search, page, limit]);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

  useEffect(() => {
    fetchVisas();
  }, [fetchVisas]);

  useEffect(() => {
    (async () => {
      try {
        const res = await libraryService.getAll('VISA_TYPE', true);
        if (res?.success) setVisaTypes(res.data.map((i) => i.label));
      } catch {
        /* non-fatal */
      }
    })();
  }, []);

  const statusBadge = (visa: VisaRecord) => {
    const expSoon = visa.status === 'ACTIVE' && visa.isExpiringSoon;
    const cls = expSoon
      ? VISA_EXPIRING_SOON_CLASS
      : VISA_STATUS_CLASSES[visa.status as VisaStatus] || VISA_STATUS_CLASSES.CANCELLED;
    const label = expSoon
      ? t('statusExpiringSoon')
      : t(VISA_STATUS_LABEL_KEYS[visa.status as VisaStatus] || 'statusCancelled');
    return (
      <span className={`inline-block px-2.5 py-1 rounded-full text-xs font-medium ${cls}`}>
        {label}
      </span>
    );
  };

  const handleExport = async () => {
    // Export the full filtered set (not just the current page).
    const res = await visaService.getAll({
      status: status || undefined,
      country: country || undefined,
      documentType: documentType || undefined,
      expiringInDays: expiringInDays ? Number(expiringInDays) : undefined,
      search: search || undefined,
      page: 1,
      limit: 100,
    });
    const rows: (string | number)[][] = [
      [
        t('employee'),
        t('department'),
        t('visaNumber'),
        t('visaType'),
        t('country'),
        t('issueDate'),
        t('expiryDate'),
        t('daysRemaining'),
        t('status'),
      ],
    ];
    let items = res?.data || [];
    if ((res?.meta?.totalPages || 1) > 1) {
      for (let p = 2; p <= (res.meta.totalPages || 1); p++) {
        const next = await visaService.getAll({
          status: status || undefined,
          country: country || undefined,
          documentType: documentType || undefined,
          expiringInDays: expiringInDays ? Number(expiringInDays) : undefined,
          search: search || undefined,
          page: p,
          limit: 100,
        });
        items = items.concat(next?.data || []);
      }
    }
    for (const v of items) {
      rows.push([
        v.employee?.fullName || '',
        v.employee?.department?.name || '',
        v.documentNumber,
        v.documentType,
        v.country,
        formatDate(v.issueDate),
        formatDate(v.expiryDate),
        v.status === 'ACTIVE' ? v.daysUntilExpiry : '',
        v.status === 'ACTIVE' && v.isExpiringSoon ? 'EXPIRING_SOON' : v.status,
      ]);
    }
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Visas');
    XLSX.writeFile(wb, `Visa_Report_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  const summaryCards = [
    {
      key: 'active',
      label: t('summaryActive'),
      value: summary?.active ?? '—',
      icon: CheckCircle,
      cls: 'text-status-success bg-status-success-bg',
    },
    {
      key: 'expiring',
      label: t('summaryExpiringSoon'),
      value: summary?.expiringSoon ?? '—',
      icon: AlertTriangle,
      cls: 'text-status-warning bg-status-warning-bg',
    },
    {
      key: 'expired',
      label: t('summaryExpired'),
      value: summary?.expired ?? '—',
      icon: XCircle,
      cls: 'text-status-error bg-status-error-bg',
    },
    {
      label: t('summaryRenewedThisYear'),
      value: summary?.renewedThisYear ?? '—',
      icon: RefreshCw,
      cls: 'text-status-info bg-status-info-bg',
    },
  ];

  const resetPageAnd = <T,>(setter: (v: T) => void) => (v: T) => {
    setPage(1);
    setter(v);
  };

  return (
    <div className="p-6 space-y-6">
      {/* Export only — the title/subtitle live in the sticky TopHeader,
          declared via usePageHeader above. */}
      <PageActionRow
        action={<ExportButton onExport={handleExport} label={t('export')} testId="visa-export" />}
      />

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {summaryCards.map((card) => (
          <div
            key={card.label}
            data-testid={`visa-summary-${card.key}`}
            className="bg-surface-card border border-surface-border rounded-xl p-4 flex items-center gap-3"
          >
            <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${card.cls}`}>
              <card.icon className="w-5 h-5" />
            </div>
            <div>
              <p className="text-2xl font-bold text-text-heading">{card.value}</p>
              <p className="text-xs text-text-muted">{card.label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="bg-surface-card border border-surface-border rounded-xl p-4 grid grid-cols-1 md:grid-cols-5 gap-3">
        <div className="relative md:col-span-2">
          <Search className="w-4 h-4 text-text-muted absolute start-3 top-1/2 -translate-y-1/2" />
          <input
            data-testid="visa-search"
            type="text"
            value={search}
            onChange={(e) => resetPageAnd(setSearch)(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="w-full ps-9 pe-3 py-2 border border-surface-border rounded-lg bg-surface-card text-text-body text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary/40"
          />
        </div>
        <select
          data-testid="visa-filter-status"
          value={status}
          onChange={(e) => resetPageAnd(setStatus)(e.target.value)}
          className="px-3 py-2 border border-surface-border rounded-lg bg-surface-card text-text-body text-sm"
        >
          <option value="">
            {t('filterStatus')}: {t('filterAll')}
          </option>
          <option value="ACTIVE">{t('statusActive')}</option>
          <option value="EXPIRED">{t('statusExpired')}</option>
          <option value="RENEWED">{t('statusRenewed')}</option>
          <option value="CANCELLED">{t('statusCancelled')}</option>
        </select>
        <select
          data-testid="visa-filter-type"
          value={documentType}
          onChange={(e) => resetPageAnd(setDocumentType)(e.target.value)}
          className="px-3 py-2 border border-surface-border rounded-lg bg-surface-card text-text-body text-sm"
        >
          <option value="">
            {t('filterType')}: {t('filterAll')}
          </option>
          {visaTypes.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
        <select
          data-testid="visa-filter-expiring"
          value={expiringInDays}
          onChange={(e) => resetPageAnd(setExpiringInDays)(e.target.value)}
          className="px-3 py-2 border border-surface-border rounded-lg bg-surface-card text-text-body text-sm"
        >
          <option value="">
            {t('filterExpiringIn')}: {t('filterAll')}
          </option>
          <option value="7">7d</option>
          <option value="15">15d</option>
          <option value="30">30d</option>
          <option value="60">60d</option>
          <option value="90">90d</option>
        </select>
      </div>

      {/* Table */}
      <div className="bg-surface-card border border-surface-border rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-page text-text-muted text-start">
                <th className="px-4 py-3 text-start font-semibold">{t('employee')}</th>
                <th className="px-4 py-3 text-start font-semibold">{t('visaNumber')}</th>
                <th className="px-4 py-3 text-start font-semibold">{t('visaType')}</th>
                <th className="px-4 py-3 text-start font-semibold">{t('country')}</th>
                <th className="px-4 py-3 text-start font-semibold">{t('expiryDate')}</th>
                <th className="px-4 py-3 text-start font-semibold">{t('daysRemaining')}</th>
                <th className="px-4 py-3 text-start font-semibold">{t('status')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border">
              {loading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}>
                    <td colSpan={7} className="px-4 py-3">
                      <div className="h-5 bg-surface-page rounded animate-pulse" />
                    </td>
                  </tr>
                ))
              ) : visas.length === 0 ? (
                <tr>
                  <td data-testid="visa-empty" colSpan={7} className="px-4 py-10 text-center text-text-muted">
                    {t('noResults')}
                  </td>
                </tr>
              ) : (
                visas.map((visa) => (
                  <tr
                    key={visa.id}
                    data-testid={`visa-report-row-${visa.documentNumber}`}
                    onClick={() =>
                      router.push(`/dashboard/employees/${visa.employeeId}?section=visa`)
                    }
                    className="hover:bg-surface-page cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-3">
                      <p className="font-medium text-text-heading">{visa.employee?.fullName}</p>
                      <p className="text-xs text-text-muted">
                        {visa.employee?.employeeCode}
                        {visa.employee?.department?.name
                          ? ` · ${visa.employee.department.name}`
                          : ''}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-text-body">{visa.documentNumber}</td>
                    <td className="px-4 py-3 text-text-body">{visa.documentType}</td>
                    <td className="px-4 py-3 text-text-body">{visa.country}</td>
                    <td className="px-4 py-3 text-text-body">{formatDate(visa.expiryDate)}</td>
                    <td className="px-4 py-3">
                      {visa.status === 'ACTIVE' ? (
                        <span
                          className={
                            visa.daysUntilExpiry <= 7
                              ? 'text-status-error font-semibold'
                              : visa.isExpiringSoon
                                ? 'text-status-warning font-semibold'
                                : 'text-text-body'
                          }
                        >
                          {t('daysCount', { count: Math.max(visa.daysUntilExpiry, 0) })}
                        </span>
                      ) : (
                        <span className="text-text-muted">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">{statusBadge(visa)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {totalPages > 1 && (
          <div className="border-t border-surface-border px-4 py-3">
            <Pagination
              currentPage={page}
              totalPages={totalPages}
              totalItems={total}
              itemsPerPage={limit}
              onPageChange={setPage}
              onItemsPerPageChange={(n) => {
                setLimit(n);
                setPage(1);
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export default function VisaReportsPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER']}>
      <VisaReportsContent />
    </ProtectedRoute>
  );
}

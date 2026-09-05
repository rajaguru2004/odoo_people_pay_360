'use client';

import { useState, useEffect, useCallback } from 'react';
import { getCompanyTz } from '@/utils/formatters';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Search, Filter, Plus, Download, Loader2, FileSignature, X, AlertCircle } from 'lucide-react';
import contractService from '@/services/contractService';
import departmentService from '@/services/departmentService';
import exportService from '@/services/exportService';
import { Contract } from '@/types/contract';
import { Department } from '@/types/department';
import { toast } from '@/lib/toast';

// RBAC
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePermission } from '@/hooks/usePermission';

// Components
import ContractStatsBar from '@/components/contracts/ContractStatsBar';
import ContractFilterPanel, { ContractFilterState } from '@/components/contracts/ContractFilterPanel';
import PageActionRow from '@/components/common/PageActionRow';
import { usePageHeader } from '@/hooks/usePageHeader';

export default function ContractsPage() {
    const router = useRouter();
    const { can } = usePermission();
    const t = useTranslations('contractsListPage');
    const tc = useTranslations('common');

    // The one heading for this route, rendered by TopHeader.
    usePageHeader(t('title'), t('subtitle'));

    // Data State
    const [contracts, setContracts] = useState<Contract[]>([]);
    const [departments, setDepartments] = useState<Department[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');

    // Pagination
    const [page, setPage] = useState(1);
    const [total, setTotal] = useState(0);
    const limit = 20;

    // UI State
    const [showFilterPanel, setShowFilterPanel] = useState(false);
    const [exporting, setExporting] = useState(false);

    // Filter State
    const [filters, setFilters] = useState<ContractFilterState>({
        statuses: [],
        contractTypes: [],
        departments: [],
        expiring: false,
    });

    // Stats
    const [stats, setStats] = useState({
        total: 0,
        active: 0,
        expired: 0,
        expiringSoon: 0,
    });

    // Debounce search
    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedSearch(searchTerm);
            setPage(1);
        }, 300);
        return () => clearTimeout(timer);
    }, [searchTerm]);

    // Fetch departments
    useEffect(() => {
        fetchDepartments();
    }, []);

    // Fetch contracts when filters change
    useEffect(() => {
        fetchContracts();
    }, [debouncedSearch, filters, page]);

    // Fetch stats
    useEffect(() => {
        fetchStats();
    }, []);

    const fetchDepartments = async () => {
        try {
            const response = await departmentService.getAll();
            setDepartments(response.data || []);
        } catch (error) {
            console.error('Failed to fetch departments:', error);
        }
    };

    const fetchContracts = useCallback(async () => {
        try {
            setLoading(true);

            // Build API params
            const params: any = {
                page,
                limit,
                search: debouncedSearch || undefined,
            };

            // Apply filters
            if (filters.statuses.length === 1) {
                params.status = filters.statuses[0];
            }
            if (filters.contractTypes.length === 1) {
                params.contractType = filters.contractTypes[0];
            }

            const response = await contractService.getAll(params);

            if (response.success && response.data) {
                let filteredData = Array.isArray(response.data) ? response.data : [];

                // Client-side filtering for multi-select
                if (filters.statuses.length > 1) {
                    filteredData = filteredData.filter(c => filters.statuses.includes(c.status));
                }
                if (filters.contractTypes.length > 1) {
                    filteredData = filteredData.filter(c => filters.contractTypes.includes(c.contractType));
                }
                if (filters.departments.length > 0) {
                    filteredData = filteredData.filter(c =>
                        filters.departments.includes(c.employee?.department?.id)
                    );
                }
                if (filters.expiring) {
                    const now = new Date();
                    const thirtyDaysLater = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
                    filteredData = filteredData.filter(c => {
                        if (!c.endDate) return false;
                        const endDate = new Date(c.endDate);
                        return endDate >= now && endDate <= thirtyDaysLater;
                    });
                }

                setContracts(filteredData);
                setTotal(response.meta?.total || filteredData.length);
            }
        } catch (error) {
            console.error('Failed to fetch contracts:', error);
            toast.error('Unable to load contract list');
        } finally {
            setLoading(false);
        }
    }, [page, limit, debouncedSearch, filters]);

    const fetchStats = async () => {
        try {
            const statsRes = await contractService.getStatistics();
            const data = statsRes.data || statsRes;

            setStats({
                total: data.total || 0,
                active: data.active || 0,
                expired: data.expired || 0,
                expiringSoon: data.expiringSoon || 0,
            });
        } catch (error) {
            console.error('Failed to fetch stats:', error);
        }
    };

    const handleExport = async () => {
        try {
            setExporting(true);
            const params: any = {};
            if (debouncedSearch) params.search = debouncedSearch;
            if (filters.statuses.length > 0) params.status = filters.statuses.join(',');
            if (filters.contractTypes.length > 0) params.contractType = filters.contractTypes.join(',');
            if (filters.departments.length > 0) params.departmentId = filters.departments.join(',');
            if (filters.expiring) params.expiring = 'true';

            await exportService.exportAndDownloadContracts(params);
            toast.success(t('exportSuccess'));
        } catch (error) {
            console.error('Failed to export contracts:', error);
            toast.error(t('exportFailed'));
        } finally {
            setExporting(false);
        }
    };

    const activeFilterCount =
        filters.statuses.length +
        filters.contractTypes.length +
        filters.departments.length +
        (filters.expiring ? 1 : 0);

    const clearFilters = () => {
        setFilters({
            statuses: [],
            contractTypes: [],
            departments: [],
            expiring: false,
        });
        setSearchTerm('');
    };

    const getStatusBadge = (status: string) => {
        const styles: Record<string, string> = {
            ACTIVE: 'bg-status-success-bg text-status-success border-status-success/20',
            EXPIRED: 'bg-status-error-bg text-status-error border-status-error/20',
            TERMINATED: 'bg-surface-page text-text-muted border-surface-border',
        };
        const labels: Record<string, string> = {
            ACTIVE: t('statusActive'),
            EXPIRED: t('statusExpired'),
            TERMINATED: t('statusTerminated'),
        };
        return (
            <span className={`px-3 py-1 rounded-[--radius-badge] text-xs font-semibold border ${styles[status] || 'bg-surface-page text-text-muted border-surface-border'}`}>
                {labels[status] || status}
            </span>
        );
    };

    const getContractTypeBadge = (type: string) => {
        const labels: Record<string, string> = {
            PROBATION: t('typeProbation'),
            FIXED_TERM: t('typeFixedTerm'),
            INDEFINITE: t('typeIndefinite'),
        };
        return (
            <span className="px-3 py-1 rounded-[--radius-badge] text-xs font-semibold bg-brand-primary-light/20 text-brand-primary border border-brand-primary/20">
                {labels[type] || type}
            </span>
        );
    };

    const getWorkTypeBadge = (workType: string, hours?: number) => {
        const labels: Record<string, string> = {
            FULL_TIME: t('workFullTime'),
            PART_TIME: t('workPartTime'),
        };
        const colors: Record<string, string> = {
            FULL_TIME: 'bg-status-success-bg text-status-success border-status-success/20',
            PART_TIME: 'bg-brand-accent/10 text-brand-accent border-brand-accent/20',
        };
        return (
            <span className={`px-3 py-1 rounded-[--radius-badge] text-xs font-semibold border ${colors[workType] || 'bg-surface-page text-text-muted border-surface-border'}`}>
                {labels[workType] || workType}
                {workType === 'PART_TIME' && hours && t('hoursPerWeekSuffix', { hours })}
            </span>
        );
    };

    const formatDate = (date: string) => {
        return new Date(date).toLocaleDateString('en-IN', { timeZone: getCompanyTz() });
    };

    return (
        <ProtectedRoute requiredPermission="VIEW_CONTRACTS">
            <>
                <div className="space-y-6">
                    {/* Heading lives in TopHeader via usePageHeader — only the action stays here. */}
                    <PageActionRow
                        action={
                            can('MANAGE_CONTRACTS') && (
                                <button
                                    data-testid="con-create"
                                    onClick={() => router.push('/dashboard/contracts/new')}
                                    className="flex items-center gap-2 px-5 py-3 bg-brand-primary text-text-on-brand rounded-[--radius-button] hover:bg-brand-primary-dark hover:shadow-xl hover:scale-105 transition-all font-semibold shadow-lg"
                                >
                                    <Plus size={20} />
                                    {t('createNewContract')}
                                </button>
                            )
                        }
                    />

                    {/* Stats Bar */}
                    <ContractStatsBar
                        total={stats.total}
                        active={stats.active}
                        expired={stats.expired}
                        expiringSoon={stats.expiringSoon}
                    />

                    {/* Search & Filter Bar */}
                    <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
                        <div className="flex-1 w-full sm:w-auto">
                            <div className="relative">
                                <Search className="absolute start-4 top-1/2 -translate-y-1/2 text-text-muted" size={20} />
                                <input
                                    data-testid="con-search"
                                    type="text"
                                    placeholder={t('searchPlaceholder')}
                                    value={searchTerm}
                                    onChange={(e) => setSearchTerm(e.target.value)}
                                    className="w-full ps-12 pe-4 py-3 border border-surface-border bg-surface-card text-text-body rounded-[--radius-input] focus:border-brand-primary focus:ring-4 focus:ring-brand-primary/10 transition-all"
                                />
                                {searchTerm && (
                                    <button
                                        onClick={() => setSearchTerm('')}
                                        className="absolute end-4 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-body"
                                    >
                                        <X size={18} />
                                    </button>
                                )}
                            </div>
                        </div>

                        <div className="flex items-center gap-3">
                            <button
                                data-testid="con-terminations-link"
                                onClick={() => router.push('/dashboard/contracts/terminations')}
                                className="flex items-center gap-2 px-4 py-3 bg-surface-card border border-brand-accent/30 rounded-[--radius-button] hover:border-brand-accent hover:bg-brand-accent/5 transition-all font-semibold text-brand-accent-dark"
                            >
                                <AlertCircle size={20} />
                                <span className="hidden sm:inline">{t('terminationOfContract')}</span>
                            </button>

                            <button
                                data-testid="con-filter-open"
                                onClick={() => setShowFilterPanel(true)}
                                className={`flex items-center gap-2 px-4 py-3 rounded-[--radius-button] font-semibold transition-all ${
                                    activeFilterCount > 0
                                        ? 'bg-brand-primary text-text-on-brand shadow-lg'
                                        : 'bg-surface-card border border-surface-border text-text-body hover:border-brand-primary/30'
                                }`}
                            >
                                <Filter size={20} />
                                <span>{t('filter')}</span>
                                {activeFilterCount > 0 && (
                                    <span className="px-2 py-0.5 bg-text-on-brand text-brand-primary rounded-[--radius-badge] text-xs font-bold">
                                        {activeFilterCount}
                                    </span>
                                )}
                            </button>

                            <button
                                data-testid="con-export"
                                onClick={handleExport}
                                disabled={exporting}
                                className="flex items-center gap-2 px-4 py-3 bg-surface-card border border-surface-border rounded-[--radius-button] hover:border-status-success/50 hover:bg-status-success-bg/10 transition-all font-semibold text-text-body disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {exporting ? <Loader2 size={20} className="animate-spin" /> : <Download size={20} />}
                                <span className="hidden sm:inline">{t('export')}</span>
                            </button>
                        </div>
                    </div>

                    {/* Active Filters */}
                    {activeFilterCount > 0 && (
                        <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-semibold text-text-muted">{t('filteringLabel')}</span>
                            {filters.statuses.map((status) => (
                                <span
                                    key={status}
                                    className="px-3 py-1 bg-brand-primary-light/20 text-brand-primary rounded-[--radius-button] text-sm font-medium"
                                >
                                    {status}
                                </span>
                            ))}
                            {filters.contractTypes.map((type) => (
                                <span
                                    key={type}
                                    className="px-3 py-1 bg-status-info-bg text-status-info rounded-[--radius-button] text-sm font-medium"
                                >
                                    {type}
                                </span>
                            ))}
                            {filters.expiring && (
                                <span
                                    key="expiring"
                                    className="px-3 py-1 bg-brand-accent/10 text-brand-accent rounded-[--radius-button] text-sm font-medium"
                                >
                                    {t('aboutToExpire')}
                                </span>
                            )}
                            <button
                                onClick={clearFilters}
                                className="px-3 py-1 text-sm font-medium text-status-error hover:bg-status-error-bg/20 rounded-[--radius-button] transition-colors"
                            >
                                {t('clearAll')}
                            </button>
                        </div>
                    )}

                    {/* Contracts Table */}
                    <div className="bg-surface-card rounded-[--radius-card] shadow-sm border border-surface-border overflow-hidden">
                        {loading ? (
                            <div className="p-12 text-center">
                                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-brand-primary mx-auto mb-4"></div>
                                <p className="text-text-muted font-medium">{tc('loading')}</p>
                            </div>
                        ) : contracts.length === 0 ? (
                            <div data-testid="con-empty" className="p-12 text-center">
                                <FileSignature className="w-16 h-16 text-text-muted/40 mx-auto mb-4" />
                                <p className="text-text-muted font-medium mb-2">{t('noContract')}</p>
                                <p className="text-text-muted/60 text-sm">
                                    {t('noContractDesc')}
                                </p>
                            </div>
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="w-full">
                                    <thead className="bg-surface-page border-b border-surface-border">
                                        <tr>
                                            <th className="px-4 py-3 text-start text-xs font-bold text-text-muted uppercase">
                                                {t('colContractNumber')}
                                            </th>
                                            <th className="px-4 py-3 text-start text-xs font-bold text-text-muted uppercase">
                                                {t('colEmployees')}
                                            </th>
                                            <th className="px-4 py-3 text-start text-xs font-bold text-text-muted uppercase">
                                                {t('colContractType')}
                                            </th>
                                            <th className="px-4 py-3 text-start text-xs font-bold text-text-muted uppercase">
                                                {t('colForm')}
                                            </th>
                                            <th className="px-4 py-3 text-start text-xs font-bold text-text-muted uppercase">
                                                {tc('startDate')}
                                            </th>
                                            <th className="px-4 py-3 text-start text-xs font-bold text-text-muted uppercase">
                                                {tc('endDate')}
                                            </th>
                                            <th className="px-4 py-3 text-start text-xs font-bold text-text-muted uppercase">
                                                {tc('status')}
                                            </th>
                                            <th className="px-4 py-3 text-center text-xs font-bold text-text-muted uppercase">
                                                {t('colOperation')}
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-surface-border">
                                        {contracts.map((contract) => (
                                            <tr
                                                key={contract.id}
                                                data-testid={`con-row-${contract.contractNumber ?? contract.id}`}
                                                className="hover:bg-surface-page transition-colors"
                                            >
                                                <td className="px-4 py-3 whitespace-nowrap">
                                                    <span className="text-sm font-bold text-text-heading">
                                                        {contract.contractNumber}
                                                    </span>
                                                </td>
                                                <td className="px-4 py-3">
                                                    <div>
                                                        <div className="text-sm font-semibold text-text-heading">
                                                            {contract.employee.fullName}
                                                        </div>
                                                        <div className="text-xs text-text-muted">
                                                            {contract.employee.position}
                                                        </div>
                                                    </div>
                                                </td>
                                                <td className="px-4 py-3 whitespace-nowrap">
                                                    {getContractTypeBadge(contract.contractType)}
                                                </td>
                                                <td className="px-4 py-3 whitespace-nowrap">
                                                    {getWorkTypeBadge(
                                                        contract.workType,
                                                        contract.workHoursPerWeek
                                                    )}
                                                </td>
                                                <td className="px-4 py-3 whitespace-nowrap text-sm text-text-body">
                                                    {formatDate(contract.startDate)}
                                                </td>
                                                <td className="px-4 py-3 whitespace-nowrap text-sm text-text-body">
                                                    {contract.endDate ? (
                                                        formatDate(contract.endDate)
                                                    ) : (
                                                        <span className="text-text-muted/55">{t('notDetermined')}</span>
                                                    )}
                                                </td>
                                                <td
                                                    data-testid={`con-status-${contract.contractNumber ?? contract.id}`}
                                                    className="px-4 py-3 whitespace-nowrap"
                                                >
                                                    {getStatusBadge(contract.status)}
                                                </td>
                                                <td className="px-4 py-3 whitespace-nowrap text-center">
                                                    <button
                                                        onClick={() =>
                                                            router.push(`/dashboard/contracts/${contract.id}`)
                                                        }
                                                        className="text-brand-primary hover:text-brand-primary-dark font-semibold hover:underline text-sm"
                                                    >
                                                        {t('detailsArrow')}
                                                    </button>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>

                    {/* Pagination */}
                    {!loading && contracts.length > 0 && (
                        <div className="flex items-center justify-between bg-surface-card rounded-[--radius-card] p-4 border border-surface-border">
                            <div className="text-sm text-text-body font-medium">
                                {t('paginationDisplay', {
                                    start: (page - 1) * limit + 1,
                                    end: Math.min(page * limit, total),
                                    total,
                                })}
                            </div>
                            <div className="flex gap-2">
                                <button
                                    onClick={() => setPage((prev) => prev - 1)}
                                    disabled={page === 1}
                                    className="px-4 py-2 border border-surface-border rounded-[--radius-button] hover:bg-surface-page disabled:opacity-50 disabled:cursor-not-allowed font-semibold text-text-body transition-all"
                                >
                                    {t('previousArrow')}
                                </button>
                                <button
                                    onClick={() => setPage((prev) => prev + 1)}
                                    disabled={page * limit >= total}
                                    className="px-4 py-2 border border-surface-border rounded-[--radius-button] hover:bg-surface-page disabled:opacity-50 disabled:cursor-not-allowed font-semibold text-text-body transition-all"
                                >
                                    {t('nextArrow')}
                                </button>
                            </div>
                        </div>
                    )}

                    {/* Filter Panel */}
                    {showFilterPanel && (
                        <ContractFilterPanel
                            isOpen={showFilterPanel}
                            onClose={() => setShowFilterPanel(false)}
                            filters={filters}
                            onFilterChange={setFilters}
                            departments={departments}
                        />
                    )}
                </div>
            </>
        </ProtectedRoute>
    );
}

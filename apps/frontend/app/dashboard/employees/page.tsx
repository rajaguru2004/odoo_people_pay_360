'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Search, Filter, Plus, Download, X, FileSpreadsheet } from 'lucide-react';
import employeeService from '@/services/employeeService';
import departmentService from '@/services/departmentService';
import libraryService from '@/services/libraryService';
import { Employee } from '@/types/employee';
import { Department } from '@/types/department';
import { useBranchStore } from '@/store/branchStore';

// RBAC
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePermission } from '@/hooks/usePermission';

// New Components
import EmployeeViewSwitcher, { ViewType } from '@/components/employees/EmployeeViewSwitcher';
import EmployeeFilterPanel, { FilterState } from '@/components/employees/EmployeeFilterPanel';
import QuickFilterChips from '@/components/employees/QuickFilterChips';
import EmployeeTableView from '@/components/employees/EmployeeTableView';
import EmployeeCardView from '@/components/employees/EmployeeCardView';
import EmployeeKanbanView from '@/components/employees/EmployeeKanbanView';
import EmployeeStatsBar from '@/components/employees/EmployeeStatsBar';
import ExportModal from '@/components/employees/ExportModal';
import ImportModal from '@/components/employees/ImportModal';
import ColumnPicker, { loadSelectedColumns } from '@/components/employees/ColumnPicker';
import { useProfileTemplate } from '@/hooks/useProfileTemplate';
import { listColumnCandidates } from '@/components/dynamic-form/fieldValue';

export default function EmployeesPage() {
  const router = useRouter();
  const { can, isAdmin, isHRManager } = usePermission();
  // Mirrors the backend's @Roles on /employees/statistics.
  const canViewStatistics = isAdmin() || isHRManager();
  const t = useTranslations('employeesListPage');
  const tc = useTranslations('common');
  // Multi-branch: re-scope the list + stats when the active branch changes.
  const selectedBranchId = useBranchStore((s) => s.selectedBranchId);

  // Force component version - change this to force reload
  const COMPONENT_VERSION = 'v2.0.0';

  // Data State
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [positions, setPositions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalEmployees, setTotalEmployees] = useState(0); // Real total from statistics
  const [statistics, setStatistics] = useState<any>(null); // Full statistics data

  // UI State
  const [currentView, setCurrentView] = useState<ViewType>('table');
  const limit = currentView === 'kanban' ? 1000 : 20;
  const [showFilterPanel, setShowFilterPanel] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);

  // Extra list columns come from the active employee template; which of them are
  // shown is a per-user preference (see ColumnPicker), not template config.
  const { data: listTemplate } = useProfileTemplate({ mode: 'EDIT' });
  const columnCandidates = useMemo(
    () => listColumnCandidates(listTemplate?.fields ?? []),
    [listTemplate],
  );
  const [selectedColumns, setSelectedColumns] = useState<string[]>([]);
  useEffect(() => {
    // Read after mount: localStorage does not exist during SSR.
    setSelectedColumns(loadSelectedColumns());
  }, []);
  const extraColumns = useMemo(
    () =>
      selectedColumns
        .map((k) => columnCandidates.find((f) => f.fieldKey === k))
        .filter((f): f is NonNullable<typeof f> => Boolean(f)),
    [selectedColumns, columnCandidates],
  );
  const [showImportModal, setShowImportModal] = useState(false);

  // Filter State
  const [filters, setFilters] = useState<FilterState>({
    departments: [],
    positions: [],
    statuses: [],
    dateRange: {},
  });

  // Debounce search term - reduced to 300ms for faster response
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchTerm);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  // Fetch departments and positions (company-wide, not branch-scoped)
  useEffect(() => {
    fetchDepartments();
    fetchPositions();
  }, []);

  // Refetch branch-scoped statistics and reset to page 1 on branch switch (also runs on mount).
  useEffect(() => {
    fetchStatistics();
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBranchId]);

  // Reset page when filter changes
  useEffect(() => {
    setPage(1);
  }, [filters]);

  // Reset page when view changes
  useEffect(() => {
    setPage(1);
  }, [currentView]);

  const fetchDepartments = async () => {
    try {
      const response = await departmentService.getAll();
      setDepartments(response.data);
    } catch (error) {
      console.error('Failed to fetch departments:', error);
    }
  };

  const fetchPositions = async () => {
    try {
      const response = await libraryService.getAll('POSITION', true);
      if (response?.success) {
        setPositions(response.data.map((p: any) => p.label));
      } else {
        // fallback
        const uniquePositions = Array.from(new Set(employees.map(e => e.position)));
        setPositions(uniquePositions.length > 0 ? uniquePositions : ['Manager', 'Employee']);
      }
    } catch (error) {
      console.error('Failed to fetch positions:', error);
      const uniquePositions = Array.from(new Set(employees.map(e => e.position)));
      setPositions(uniquePositions.length > 0 ? uniquePositions : ['Manager', 'Employee']);
    }
  };

  const fetchStatistics = async () => {
    // `/employees/statistics` is ADMIN and HR only, while the directory itself
    // is open to MANAGER as well. Asking for it as a manager guaranteed a 403
    // on every visit — a logged error, an empty stats bar, and nothing the user
    // could do about it. Checked here rather than swallowed in the catch so the
    // request is not made at all.
    if (!canViewStatistics) return;
    try {
      const response = await employeeService.getStatistics();
      setTotalEmployees(response.data?.total || 0);
      setStatistics(response.data); // Store full statistics
    } catch (error) {
      console.error('Failed to fetch statistics:', error);
    }
  };

  const fetchEmployees = useCallback(async () => {
    try {
      setLoading(true);

      const timestamp = new Date().toISOString();
      console.log(`=== FETCH EMPLOYEES START [${timestamp}] ===`);
      console.log('COMPONENT VERSION:', COMPONENT_VERSION);
      console.log('Filters:', JSON.stringify(filters, null, 2));

      const hasClientSideFilters =
        filters.departments.length > 1 ||
        filters.positions.length > 1 ||
        filters.statuses.length > 1 ||
        !!(filters.dateRange?.from || filters.dateRange?.to);

      // Build API params with backend-supported filters
      const params: any = {
        page: hasClientSideFilters ? 1 : page,
        limit: hasClientSideFilters ? 1000 : Math.min(limit, 1000),
        search: debouncedSearch || undefined,
      };

      // Backend supports these filters directly
      if (filters.departments.length === 1) {
        params.departmentId = filters.departments[0];
      }

      if (filters.statuses.length === 1) {
        params.status = filters.statuses[0];
      }

      if (filters.positions.length === 1) {
        params.position = filters.positions[0];
      }

      console.log('API Params:', JSON.stringify(params, null, 2));

      const response = await employeeService.getAll(params);

      if (!response || !response.data) {
        console.error('Invalid response:', response);
        setEmployees([]);
        setTotal(0);
        return;
      }

      console.log('API Response:', response.data.length, 'employees');

      // Client-side filtering for multi-select (backend only supports single value)
      let filteredData = response.data;

      // Apply multi-department filter (if more than 1 selected)
      if (filters.departments.length > 1) {
        console.log('Client-side filtering by departments:', filters.departments);
        const beforeCount = filteredData.length;
        filteredData = filteredData.filter(emp =>
          filters.departments.includes(emp.departmentId)
        );
        console.log(`Department filter: ${beforeCount} -> ${filteredData.length}`);
      }

      // Apply multi-position filter (if more than 1 selected)
      if (filters.positions.length > 1) {
        const beforeCount = filteredData.length;
        filteredData = filteredData.filter(emp =>
          filters.positions.includes(emp.position)
        );
        console.log(`Position filter: ${beforeCount} -> ${filteredData.length}`);
      }

      // Apply multi-status filter (if more than 1 selected)
      if (filters.statuses.length > 1) {
        const beforeCount = filteredData.length;
        filteredData = filteredData.filter(emp =>
          filters.statuses.includes(emp.status)
        );
        console.log(`Status filter: ${beforeCount} -> ${filteredData.length}`);
      }

      // Apply date range filter (backend doesn't support this)
      if (filters.dateRange?.from) {
        const beforeCount = filteredData.length;
        filteredData = filteredData.filter(emp =>
          new Date(emp.startDate) >= new Date(filters.dateRange.from!)
        );
        console.log(`Date from filter: ${beforeCount} -> ${filteredData.length}`);
      }

      if (filters.dateRange?.to) {
        const beforeCount = filteredData.length;
        filteredData = filteredData.filter(emp =>
          new Date(emp.startDate) <= new Date(filters.dateRange.to!)
        );
        console.log(`Date to filter: ${beforeCount} -> ${filteredData.length}`);
      }

      console.log('Final filtered count:', filteredData.length);
      console.log('=== FETCH EMPLOYEES END ===');

      if (hasClientSideFilters) {
        const startIndex = (page - 1) * limit;
        const paginatedData = filteredData.slice(startIndex, startIndex + limit);
        setEmployees(paginatedData);
        setTotal(filteredData.length);
      } else {
        setEmployees(filteredData);
        setTotal(response.meta?.total || filteredData.length);
      }
    } catch (error) {
      console.error('Failed to fetch employees:', error);
      setEmployees([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [page, limit, debouncedSearch, filters, COMPONENT_VERSION, selectedBranchId]);

  useEffect(() => {
    fetchEmployees();
    fetchPositions();
  }, [fetchEmployees]);

  const handleQuickFilter = (quickFilter: any) => {
    setFilters(prev => ({
      ...prev,
      ...quickFilter,
    }));
    setPage(1);
  };

  const clearAllFilters = () => {
    setFilters({
      departments: [],
      positions: [],
      statuses: [],
      dateRange: {},
    });
    setSearchTerm('');
    setPage(1);
  };

  const hasDateRangeFilter = () => {
    return !!(filters.dateRange?.from || filters.dateRange?.to);
  };

  const activeFilterCount =
    filters.departments.length +
    filters.positions.length +
    filters.statuses.length +
    (hasDateRangeFilter() ? 1 : 0);

  const totalPages = Math.ceil(total / limit);

  return (
    <ProtectedRoute requiredPermission="VIEW_EMPLOYEES">
      <>
        <div className="space-y-4">
          {/* Action Bar */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            {/* Left side - Primary action */}
            <div className="flex items-center gap-3">
              {can('CREATE_EMPLOYEE') && (
                <button
                  data-testid="emp-new"
                  onClick={() => router.push('/dashboard/employees/new')}
                  className="flex items-center gap-2 px-5 py-2.5 bg-brand-primary text-white rounded-xl hover:shadow-2xl hover:scale-105 transition-all font-semibold shadow-lg shadow-brand-primary/30"
                >
                  <Plus size={20} />
                  {t('moreStaff')}
                </button>
              )}
              {can('CREATE_EMPLOYEE') && (
                <button
                  data-testid="employees-import-open"
                  onClick={() => setShowImportModal(true)}
                  className="flex items-center gap-2 px-5 py-2.5 border border-surface-border text-text-body bg-surface-card rounded-xl hover:bg-surface-page font-semibold hover:border-brand-primary hover:text-brand-primary transition-all shadow-xs"
                >
                  <FileSpreadsheet size={20} className="text-text-muted group-hover:text-brand-primary" />
                  {t('importExcel')}
                </button>
              )}
              {currentView === 'table' && (
                <ColumnPicker
                  candidates={columnCandidates}
                  selected={selectedColumns}
                  onChange={setSelectedColumns}
                />
              )}
              {/* Gated like Import directly above. It previously was not, so a
                  MANAGER — who sees a department-scoped directory on screen —
                  was still offered "download the list" with no permission check
                  in front of it (finding P3). The export endpoint applies its
                  own scoping, so this is about not offering an action the role
                  is not entitled to, rather than about the file's contents. */}
              {can('CREATE_EMPLOYEE') && (
              <button
                data-testid="emp-export-open"
                onClick={() => setShowExportModal(true)}
                className="flex items-center gap-2 px-5 py-2.5 border border-surface-border text-text-body bg-surface-card rounded-xl hover:bg-surface-page font-semibold hover:border-brand-primary hover:text-brand-primary transition-all shadow-xs"
                title={t('exportListTitle')}
              >
                <Download size={20} className="text-text-muted group-hover:text-brand-primary" />
                {tc('export')}
              </button>
              )}
            </div>
          </div>

          {/* Stats Bar */}
          <EmployeeStatsBar
            employees={employees}
            departmentCount={departments.length}
            totalEmployees={currentView === 'kanban' ? employees.length : totalEmployees}
            statistics={currentView === 'kanban' ? null : statistics}
          />

          {/* Toolbar */}
          <div className="bg-surface-card rounded-2xl border border-surface-border p-5 space-y-4 shadow-lg">
            {/* Search & Actions Row */}
            <div className="flex flex-col md:flex-row gap-3">
              {/* Search */}
              <div className="flex-1 relative group">
                <Search className="absolute start-4 top-1/2 -translate-y-1/2 text-text-muted group-focus-within:text-brand-primary transition-colors" size={20} />
                <input
                  data-testid="emp-search"
                  type="text"
                  placeholder={t('searchPlaceholder')}
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full ps-12 pe-10 py-3 border border-surface-border bg-surface-card text-text-body rounded-xl focus:outline-none focus:ring-4 focus:ring-brand-primary/20 focus:border-brand-primary text-sm font-medium transition-all"
                />
                {searchTerm && (
                  <button
                    data-testid="emp-search-clear"
                    onClick={() => setSearchTerm('')}
                    className="absolute end-3 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-body hover:bg-surface-page rounded-full transition-all"
                  >
                    <X size={16} />
                  </button>
                )}
              </div>

              {/* View Switcher */}
              <EmployeeViewSwitcher
                currentView={currentView}
                onViewChange={setCurrentView}
              />

              {/* Filter Button */}
              <button
                data-testid="emp-filter-open"
                onClick={() => setShowFilterPanel(true)}
                className={`
                flex items-center gap-2 px-5 py-3 rounded-xl font-semibold text-sm transition-all
                ${activeFilterCount > 0
                    ? 'bg-brand-primary text-white shadow-lg shadow-brand-primary/30 hover:shadow-xl hover:scale-105'
                    : 'border border-surface-border text-text-body hover:bg-surface-page hover:border-brand-primary'
                  }
              `}
              >
                <Filter size={18} />
                {t('filter')}
                {activeFilterCount > 0 && (
                  <span className="px-2 py-0.5 bg-surface-card text-brand-primary rounded-full text-xs font-bold shadow-md">
                    {activeFilterCount}
                  </span>
                )}
              </button>
            </div>

            {/* Quick Filters */}
            <QuickFilterChips onFilterSelect={handleQuickFilter} />

            {/* Active Filters Display */}
            {activeFilterCount > 0 && (
              <div className="flex items-center gap-2 flex-wrap pt-2 border-t border-surface-border">
                <span className="text-xs font-semibold text-text-muted">{t('filtersApplying')}</span>

                {filters.departments.map(deptId => {
                  const dept = departments.find(d => d.id === deptId);
                  return dept ? (
                    <span key={deptId} className="inline-flex items-center gap-1 px-2 py-1 bg-brand-primary-light text-brand-primary rounded text-xs font-medium">
                      {dept.name}
                      <button onClick={() => setFilters(prev => ({
                        ...prev,
                        departments: prev.departments.filter(d => d !== deptId)
                      }))}>
                        <X size={12} />
                      </button>
                    </span>
                  ) : null;
                })}

                {filters.positions.map(pos => (
                  <span key={pos} className="inline-flex items-center gap-1 px-2 py-1 bg-brand-primary-light/50 text-brand-primary rounded text-xs font-medium">
                    {pos}
                    <button onClick={() => setFilters(prev => ({
                      ...prev,
                      positions: prev.positions.filter(p => p !== pos)
                    }))}>
                      <X size={12} />
                    </button>
                  </span>
                ))}

                {filters.statuses.map(status => (
                  <span key={status} className="inline-flex items-center gap-1 px-2 py-1 bg-status-success-bg text-status-success rounded text-xs font-medium">
                    {status}
                    <button onClick={() => setFilters(prev => ({
                      ...prev,
                      statuses: prev.statuses.filter(s => s !== status)
                    }))}>
                      <X size={12} />
                    </button>
                  </span>
                ))}

                <button
                  data-testid="emp-filter-clear"
                  onClick={clearAllFilters}
                  className="text-xs text-text-muted hover:text-text-body font-medium underline"
                >
                  {t('deleteAll')}
                </button>
              </div>
            )}
          </div>

          {/* Content Area */}
          <div className="bg-surface-card rounded-2xl border border-surface-border overflow-hidden shadow-lg">
            {currentView === 'table' && (
              <EmployeeTableView
                employees={employees}
                onView={(id) => router.push(`/dashboard/employees/${id}`)}
                loading={loading}
                extraColumns={extraColumns}
              />
            )}

            {currentView === 'card' && (
              <div className="p-4">
                <EmployeeCardView
                  employees={employees}
                  onView={(id) => router.push(`/dashboard/employees/${id}`)}
                />
              </div>
            )}

            {currentView === 'kanban' && (
              <div className="p-4">
                <EmployeeKanbanView
                  employees={employees}
                  onView={(id) => router.push(`/dashboard/employees/${id}`)}
                />
              </div>
            )}
          </div>

          {/* Pagination */}
          {totalPages > 1 && currentView !== 'kanban' && (
            <div className="flex items-center justify-between bg-surface-card rounded-xl border border-surface-border px-5 py-4 shadow-lg">
              {/* The "N of M" counter. With multi-select filters the list is
                  filtered CLIENT-side over a capped fetch, so this number and
                  the rows have to be asserted together — see finding P5. */}
              <p data-testid="emp-count" className="text-sm text-text-muted font-medium">
                {t('paginationSummary', {
                  start: (page - 1) * limit + 1,
                  end: Math.min(page * limit, total),
                  total,
                })}
              </p>
              <div className="flex gap-2">
                <button
                  data-testid="emp-page-prev"
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="px-4 py-2 border border-surface-border rounded-lg hover:bg-surface-page hover:border-brand-primary disabled:opacity-50 disabled:cursor-not-allowed text-sm font-semibold transition-all"
                >
                  {t('previousPage')}
                </button>
                {[...Array(Math.min(5, totalPages))].map((_, i) => {
                  const pageNum = i + 1;
                  return (
                    <button
                      key={pageNum}
                      data-testid={`emp-page-${pageNum}`}
                      onClick={() => setPage(pageNum)}
                      className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${page === pageNum
                        ? 'bg-brand-primary text-white shadow-lg shadow-brand-primary/30'
                        : 'border border-surface-border hover:bg-surface-page hover:border-brand-primary'
                        }`}
                    >
                      {pageNum}
                    </button>
                  );
                })}
                <button
                  data-testid="emp-page-next"
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className="px-4 py-2 border border-surface-border rounded-lg hover:bg-surface-page hover:border-brand-primary disabled:opacity-50 disabled:cursor-not-allowed text-sm font-semibold transition-all"
                >
                  {t('nextPage')}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Filter Panel */}
        {showFilterPanel && (
          <EmployeeFilterPanel
            filters={filters}
            onFiltersChange={setFilters}
            departments={departments}
            positions={positions}
            onClose={() => setShowFilterPanel(false)}
          />
        )}

        {/* Export Modal */}
        {showExportModal && (
          <ExportModal
            filters={filters}
            onClose={() => setShowExportModal(false)}
          />
        )}

        {/* Import Modal */}
        {showImportModal && (
          <ImportModal
            onClose={() => {
              setShowImportModal(false);
              fetchEmployees();
              fetchStatistics();
            }}
          />
        )}
      </>
    </ProtectedRoute>
  );
}

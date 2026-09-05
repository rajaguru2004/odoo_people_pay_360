'use client';

import { useState, useEffect } from 'react';
import {
  Search,
  Users,
  CheckCircle,
  XCircle,
  Eye,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import faceRecognitionService from '@/services/faceRecognitionService';
import { FaceRegistration } from '@/components/face-recognition';
import Avatar from '@/components/common/Avatar';
import { usePageHeader } from '@/hooks/usePageHeader';
import { ChevronLeftIcon, ChevronRightIcon } from '@/components/common/icons/directional';

interface EmployeeWithFaceStatus {
  id: string;
  fullName: string;
  employeeCode: string;
  avatarUrl: string | null;
  department: { name: string } | null;
  _count: { faceDescriptors: number };
}

export default function FaceManagementPage() {
  const t = useTranslations('faceManagementPage');
  const tc = useTranslations('common');

  // The one heading for this route, rendered by TopHeader.
  usePageHeader(t('title'), t('subtitle'));

  const [selectedEmployee, setSelectedEmployee] =
    useState<EmployeeWithFaceStatus | null>(null);
  const [searchTerm, setSearchTerm] = useState('');

  return (
    <div className="min-h-screen bg-surface-page p-6">
      {selectedEmployee ? (
        /* Employee face registration detail */
        <div>
          <button
            data-testid="bio-back"
            onClick={() => setSelectedEmployee(null)}
            className="mb-4 flex items-center gap-2 text-sm text-text-body hover:text-text-heading cursor-pointer"
          >
            <ChevronLeftIcon className="h-4 w-4" /> {tc('backToList')}
          </button>
          <div className="rounded-[--radius-card] bg-surface-card border border-surface-border p-6 shadow-sm">
            <div className="mb-6 flex items-center gap-4">
              <Avatar
                src={selectedEmployee.avatarUrl}
                name={selectedEmployee.fullName}
                size="lg"
                alt={selectedEmployee.fullName}
              />
              <div>
                <h2 className="text-lg font-semibold text-text-heading">
                  {selectedEmployee.fullName}
                </h2>
                <p className="text-sm text-text-muted">
                  {selectedEmployee.employeeCode} •{' '}
                  {selectedEmployee.department?.name || t('noDepartmentsYet')}
                </p>
              </div>
            </div>

            <FaceRegistration
              employeeId={selectedEmployee.id}
              employeeName={selectedEmployee.fullName}
            />
          </div>
        </div>
      ) : (
        /* Employee list */
        <EmployeeList
          searchTerm={searchTerm}
          onSearchChange={setSearchTerm}
          onSelectEmployee={setSelectedEmployee}
        />
      )}
    </div>
  );
}

function EmployeeList({
  searchTerm,
  onSearchChange,
  onSelectEmployee,
}: {
  searchTerm: string;
  onSearchChange: (value: string) => void;
  onSelectEmployee: (employee: EmployeeWithFaceStatus) => void;
}) {
  const t = useTranslations('faceManagementPage');
  const tc = useTranslations('common');
  const [employees, setEmployees] = useState<EmployeeWithFaceStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const pageSize = 20;

  useEffect(() => {
    loadEmployees();
  }, []);

  const loadEmployees = async () => {
    try {
      setLoading(true);
      const axiosInstance = (await import('@/lib/axios')).default;
      const response = await axiosInstance.get('/employees', {
        params: { page: 1, limit: 200 },
      });
      const data = (response as any).data || (response as any);
      const employeeList = Array.isArray(data) ? data : data.data || [];
      setEmployees(employeeList);
    } catch (error) {
      console.error('Failed to load employees:', error);
    } finally {
      setLoading(false);
    }
  };

  const filteredEmployees = employees.filter(
    (emp) =>
      emp.fullName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      emp.employeeCode.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const paginatedEmployees = filteredEmployees.slice(
    (page - 1) * pageSize,
    page * pageSize
  );

  const totalPages = Math.ceil(filteredEmployees.length / pageSize);

  const registeredCount = employees.filter(
    (e) => e._count?.faceDescriptors > 0
  ).length;

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-[--radius-card] bg-surface-card border border-surface-border p-5 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="rounded-[--radius-card] bg-brand-primary-light/20 p-2">
              <Users className="h-5 w-5 text-brand-primary" />
            </div>
            <div>
              <p className="text-sm text-text-muted">{t('totalEmployees')}</p>
              <p data-testid="bio-stat-total" data-value={employees.length} className="text-2xl font-bold text-text-heading">
                {employees.length}
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-[--radius-card] bg-surface-card border border-surface-border p-5 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="rounded-[--radius-card] bg-status-success-bg/40 p-2">
              <CheckCircle className="h-5 w-5 text-status-success" />
            </div>
            <div>
              <p className="text-sm text-text-muted">{t('registered')}</p>
              <p data-testid="bio-stat-registered" data-value={registeredCount} className="text-2xl font-bold text-status-success">
                {registeredCount}
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-[--radius-card] bg-surface-card border border-surface-border p-5 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="rounded-[--radius-card] bg-status-warning-bg/40 p-2">
              <XCircle className="h-5 w-5 text-status-warning" />
            </div>
            <div>
              <p className="text-sm text-text-muted">{t('notRegistered')}</p>
              <p data-testid="bio-stat-unregistered" data-value={employees.length - registeredCount} className="text-2xl font-bold text-status-warning">
                {employees.length - registeredCount}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Search & table */}
      <div className="rounded-[--radius-card] bg-surface-card border border-surface-border shadow-sm overflow-hidden">
        <div className="border-b border-surface-border p-4">
          <div className="relative">
            <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
            <input
              data-testid="bio-search"
              type="text"
              placeholder={t('searchPlaceholder')}
              value={searchTerm}
              onChange={(e) => onSearchChange(e.target.value)}
              className="w-full rounded-[--radius-input] border border-surface-border py-2 ps-10 pe-4 text-sm focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary bg-surface-card text-text-body"
            />
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center p-8">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-primary border-t-transparent" />
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-surface-page">
                  <tr>
                    <th className="px-6 py-3 text-start text-xs font-semibold uppercase text-text-muted">
                      {tc('employee')}
                    </th>
                    <th className="px-6 py-3 text-start text-xs font-semibold uppercase text-text-muted">
                      {t('colNvCode')}
                    </th>
                    <th className="px-6 py-3 text-start text-xs font-semibold uppercase text-text-muted">
                      {tc('department')}
                    </th>
                    <th className="px-6 py-3 text-center text-xs font-semibold uppercase text-text-muted">
                      {tc('status')}
                    </th>
                    <th className="px-6 py-3 text-center text-xs font-semibold uppercase text-text-muted">
                      {t('colImageNumber')}
                    </th>
                    <th className="px-6 py-3 text-center text-xs font-semibold uppercase text-text-muted">
                      {t('colAction')}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-border-light">
                  {paginatedEmployees.map((emp) => {
                    const faceCount = emp._count?.faceDescriptors || 0;
                    const isRegistered = faceCount > 0;
                    return (
                      <tr
                        key={emp.id}
                        data-testid={`bio-row-${emp.employeeCode}`}
                        data-employee-id={emp.id}
                        data-enrolled={faceCount > 0}
                        data-face-count={faceCount}
                        className="hover:bg-surface-page/50 transition-colors"
                      >
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-3">
                            <Avatar
                              src={emp.avatarUrl}
                              name={emp.fullName}
                              size="sm"
                              alt={emp.fullName}
                            />
                            <span className="font-semibold text-text-heading">
                              {emp.fullName}
                            </span>
                          </div>
                        </td>
                        <td className="px-6 py-4 text-sm text-text-body font-mono">
                          {emp.employeeCode}
                        </td>
                        <td className="px-6 py-4 text-sm text-text-body">
                          {emp.department?.name || '-'}
                        </td>
                        <td className="px-6 py-4 text-center">
                          <span
                            className={`inline-flex items-center rounded-[--radius-badge] px-2.5 py-0.5 text-xs font-semibold ${
                              isRegistered
                                ? 'bg-status-success-bg/40 text-status-success'
                                : 'bg-status-warning-bg/40 text-status-warning'
                            }`}
                          >
                            {isRegistered ? t('registered') : t('notRegistered')}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-center text-sm">
                          <span
                            className={`font-semibold ${
                              faceCount > 0 ? 'text-status-success' : 'text-text-muted'
                            }`}
                          >
                            {faceCount}/5
                          </span>
                        </td>
                        <td className="px-6 py-4 text-center">
                          <button
                            data-testid={`bio-open-${emp.employeeCode}`}
                            onClick={() => onSelectEmployee(emp)}
                            className="inline-flex items-center gap-1 rounded-[--radius-button] bg-brand-primary-light/20 px-3 py-1.5 text-sm font-semibold text-brand-primary hover:bg-brand-primary-light/40 transition-colors cursor-pointer"
                          >
                            <Eye className="h-3.5 w-3.5" />{' '}
                            {isRegistered ? t('viewEdit') : tc('register')}{' '}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between border-t border-surface-border px-6 py-3">
                <p className="text-sm text-text-muted">
                  {t('displayRange', {
                    from: (page - 1) * pageSize + 1,
                    to: Math.min(page * pageSize, filteredEmployees.length),
                    total: filteredEmployees.length,
                  })}
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page === 1}
                    className="rounded-[--radius-button] border border-surface-border p-1.5 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-surface-page cursor-pointer"
                  >
                    <ChevronLeftIcon className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={page === totalPages}
                    className="rounded-[--radius-button] border border-surface-border p-1.5 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-surface-page cursor-pointer"
                  >
                    <ChevronRightIcon className="h-4 w-4" />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

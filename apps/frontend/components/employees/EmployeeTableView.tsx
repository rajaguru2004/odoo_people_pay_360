'use client';

import { Employee } from '@/types/employee';
import { motion } from 'framer-motion';
import { formatDate } from '@/utils/formatters';
import Avatar from '@/components/common/Avatar';
import { useTranslations } from 'next-intl';
import { TemplateField } from '@/types/profile-template';
import { displayFieldValue } from '@/components/dynamic-form/fieldValue';

interface EmployeeTableViewProps {
  employees: Employee[];
  onView: (id: string) => void;
  loading?: boolean;
  /**
   * Template fields to show after the six fixed columns. Chosen by the user via
   * the column picker; the fixed six keep their bespoke rendering (avatar,
   * status badge, link styling) rather than being flattened into this list.
   */
  extraColumns?: TemplateField[];
}

export default function EmployeeTableView({
  employees,
  onView,
  loading = false,
  extraColumns = [],
}: EmployeeTableViewProps) {
  const t = useTranslations('employeeTableView');
  const tc = useTranslations('common');

  const getStatusBadge = (status: string) => {
    const styles = {
      ACTIVE: 'bg-gradient-to-r from-green-400 to-emerald-500 text-white border-green-300 shadow-lg shadow-green-500/30',
      ON_LEAVE: 'bg-gradient-to-r from-amber-400 to-orange-500 text-white border-amber-300 shadow-lg shadow-amber-500/30',
      TERMINATED: 'bg-gradient-to-r from-red-400 to-rose-500 text-white border-red-300 shadow-lg shadow-red-500/30',
    };
    const labels = {
      ACTIVE: tc('active'),
      ON_LEAVE: tc('onLeaveStatus'),
      TERMINATED: tc('terminated'),
    };
    return (
      <span className={`px-3 py-1.5 rounded-full text-xs font-bold border-2 ${styles[status as keyof typeof styles] || 'bg-gray-100 text-gray-700'}`}>
        {labels[status as keyof typeof labels] || status}
      </span>
    );
  };

  if (loading) {
    return (
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              {[t('colCode'), t('colName'), tc('position'), tc('department'), tc('startDate'), tc('status'), 'Actions'].map((header) => (
                <th key={header} className="px-4 py-3 text-start text-xs font-semibold text-slate-600 uppercase tracking-wider">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...Array(5)].map((_, i) => (
              <tr key={i} className="animate-pulse border-b border-slate-100">
                <td className="px-4 py-3"><div className="h-4 bg-slate-100 rounded w-20"></div></td>
                <td className="px-4 py-3"><div className="h-4 bg-slate-100 rounded w-32"></div></td>
                <td className="px-4 py-3"><div className="h-4 bg-slate-100 rounded w-24"></div></td>
                <td className="px-4 py-3"><div className="h-4 bg-slate-100 rounded w-28"></div></td>
                <td className="px-4 py-3"><div className="h-4 bg-slate-100 rounded w-24"></div></td>
                <td className="px-4 py-3"><div className="h-6 bg-slate-100 rounded-full w-20"></div></td>
                <td className="px-4 py-3"><div className="h-8 bg-slate-100 rounded w-24"></div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (employees.length === 0) {
    return (
      <div data-testid="emp-empty" className="flex flex-col items-center justify-center py-16 text-slate-400">
        <p className="text-lg font-medium">{t('noEmployeesFound')}</p>
        <p className="text-sm mt-1">{t('tryAdjustingFilters')}</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead className="bg-gradient-to-r from-brand-primary via-brand-primary to-brand-primary-dark text-white sticky top-0 shadow-lg">
          <tr>
            <th className="px-4 py-3 text-start text-xs font-semibold uppercase tracking-wider">
              {t('colCode')}
            </th>
            <th className="px-4 py-3 text-start text-xs font-semibold uppercase tracking-wider">
              {t('colName')}
            </th>
            <th className="px-4 py-3 text-start text-xs font-semibold uppercase tracking-wider">
              {tc('position')}
            </th>
            <th className="px-4 py-3 text-start text-xs font-semibold uppercase tracking-wider">
              {tc('department')}
            </th>
            <th className="px-4 py-3 text-start text-xs font-semibold uppercase tracking-wider">
              {tc('startDate')}
            </th>
            <th className="px-4 py-3 text-start text-xs font-semibold uppercase tracking-wider">
              {tc('status')}
            </th>
            {extraColumns.map((f) => (
              <th
                key={f.fieldKey}
                className="px-4 py-3 text-start text-xs font-semibold uppercase tracking-wider"
              >
                {f.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-slate-100">
          {employees.map((employee, index) => (
            <motion.tr
              key={employee.id}
              // Keyed by employeeCode, not id: a spec knows the code it seeded,
              // never the uuid the server minted. Same convention as dept-row-*.
              data-testid={`emp-row-${employee.employeeCode}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: index * 0.03 }}
              onClick={() => onView(employee.id)}
              className="hover:bg-gradient-to-r hover:from-blue-50 hover:to-indigo-50 transition-all cursor-pointer group border-b border-slate-100"
              title={t('clickToSeeDetails')}
            >
              <td className="px-4 py-3 text-sm font-semibold text-brand-primary group-hover:underline">
                {employee.employeeCode}
              </td>
              <td className="px-4 py-3">
                <div className="flex items-center gap-3">
                  <Avatar 
                    src={employee.avatarUrl}
                    name={employee.fullName}
                    size="sm"
                    alt={employee.fullName}
                  />
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{employee.fullName}</p>
                    <p className="text-xs text-slate-500">{employee.email}</p>
                  </div>
                </div>
              </td>
              <td className="px-4 py-3 text-sm text-slate-700 font-medium">
                {employee.position}
              </td>
              <td className="px-4 py-3 text-sm text-slate-700">
                {employee.department?.name}
              </td>
              <td className="px-4 py-3 text-sm text-slate-600">
                {formatDate(employee.startDate)}
              </td>
              <td className="px-4 py-3">
                {getStatusBadge(employee.status)}
              </td>
              {extraColumns.map((f) => (
                <td key={f.fieldKey} className="px-4 py-3 text-sm text-slate-700">
                  {displayFieldValue(f, employee as unknown as Record<string, unknown>) ?? '—'}
                </td>
              ))}
            </motion.tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from '@/lib/toast';
import { useConfirm } from '@/hooks/useConfirm';
import { usePageHeader } from '@/hooks/usePageHeader';
import PageActionRow from '@/components/common/PageActionRow';
import { Plus, AlertTriangle, TrendingDown, Trash2, Search, Filter } from 'lucide-react';
import { CurrencyIcon } from '@/components/common/CurrencyIcon';
import { motion } from 'framer-motion';
import disciplineService from '@/services/disciplineService';
import employeeService from '@/services/employeeService';
import { Discipline, DisciplineType, CreateDisciplineData } from '@/types/discipline';
import { Employee } from '@/types/employee';
import { formatDate, formatCurrency } from '@/utils/formatters';

const disciplineTypeLabels: Record<DisciplineType, string> = {
  WARNING: 'Warning',
  FINE: 'Fine',
  DEMOTION: 'Demotion',
  TERMINATION: 'Dismissal',
};

const disciplineTypeColors: Record<DisciplineType, string> = {
  WARNING: 'bg-status-warning-bg text-status-warning',
  FINE: 'bg-status-warning-bg text-status-warning',
  DEMOTION: 'bg-status-error-bg text-status-error',
  TERMINATION: 'bg-text-heading text-surface-card',
};

export default function DisciplinesPage() {
  const router = useRouter();

  // The one heading for this route, rendered by TopHeader. Declared before the
  // loading early return so the hook order never changes.
  usePageHeader('Discipline management', 'Monitor and manage employee discipline');

  const [disciplines, setDisciplines] = useState<Discipline[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterType, setFilterType] = useState<DisciplineType | 'ALL'>('ALL');
  const { confirm, ConfirmDialog, closeModal, setLoading: setConfirmLoading } = useConfirm();

  const [formData, setFormData] = useState<CreateDisciplineData>({
    employeeId: '',
    reason: '',
    disciplineType: 'WARNING',
    amount: 0,
    disciplineDate: new Date().toISOString().split('T')[0],
  });

  const [stats, setStats] = useState({
    total: 0,
    totalFines: 0,
    thisMonth: 0,
  });

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      setLoading(true);
      const [disciplinesRes, employeesRes] = await Promise.all([
        disciplineService.getAll(),
        employeeService.getAll({ status: 'ACTIVE' }),
      ]);

      setDisciplines(disciplinesRes.data);
      setEmployees(employeesRes.data);

      // Calculate stats
      const total = disciplinesRes.data.length;
      const totalFines = disciplinesRes.data.reduce((sum: number, d: Discipline) => sum + Number(d.amount), 0);
      const thisMonth = disciplinesRes.data.filter((d: Discipline) => {
        const date = new Date(d.disciplineDate);
        const now = new Date();
        return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
      }).length;

      setStats({ total, totalFines, thisMonth });
    } catch (error) {
      console.error('Failed to fetch data:', error);
      toast.error('Unable to download data');
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
    if (!formData.employeeId || !formData.reason) {
      toast.warning('Please fill in all information');
      return;
    }

    const confirmed = await confirm({
      title: 'Confirmation creates discipline',
      message: `Are you sure you want to create discipline "${disciplineTypeLabels[formData.disciplineType]}" for this employee?`,
      confirmText: 'Create discipline',
      type: 'warning',
    });

    if (!confirmed) return;

    try {
      setConfirmLoading(true);
      await disciplineService.create(formData);
      closeModal();
      toast.success('Create successful discipline');
      setShowModal(false);
      setFormData({
        employeeId: '',
        reason: '',
        disciplineType: 'WARNING',
        amount: 0,
        disciplineDate: new Date().toISOString().split('T')[0],
      });
      fetchData();
    } catch (error: any) {
      console.error('Failed to create discipline:', error);
      let errorMessage = 'Discipline failure';

      if (error?.message) {
        errorMessage = error.message;
      } else if (error?.response?.data?.message) {
        errorMessage = error.response.data.message;
      } else if (typeof error === 'string') {
        errorMessage = error;
      }

      toast.error(errorMessage);
      setConfirmLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    const confirmed = await confirm({
      title: 'Confirm deletion',
      message: 'Are you sure you want to delete this discipline? This action cannot be undone.',
      confirmText: 'Delete',
      type: 'danger',
    });

    if (!confirmed) return;

    try {
      setConfirmLoading(true);
      await disciplineService.delete(id);
      closeModal();
      toast.success('Deleted successfully');
      fetchData();
    } catch (error: any) {
      console.error('Failed to delete discipline:', error);
      let errorMessage = 'Delete failed';

      if (error?.message) {
        errorMessage = error.message;
      } else if (error?.response?.data?.message) {
        errorMessage = error.response.data.message;
      } else if (typeof error === 'string') {
        errorMessage = error;
      }

      toast.error(errorMessage);
      setConfirmLoading(false);
    }
  };

  const filteredDisciplines = disciplines.filter((discipline) => {
    const matchSearch = discipline.employee?.fullName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      discipline.reason.toLowerCase().includes(searchTerm.toLowerCase());
    const matchType = filterType === 'ALL' || discipline.disciplineType === filterType;
    return matchSearch && matchType;
  });

  if (loading) {
    return (
      <>
        <ConfirmDialog />
        <div className="animate-pulse space-y-6">
          <div className="h-8 bg-surface-border rounded-[--radius-button] w-64"></div>
          <div className="grid grid-cols-3 gap-6">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-32 bg-surface-border/50 rounded-[--radius-card]"></div>
            ))}
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <ConfirmDialog />
      <div className="space-y-6">
        {/* Action only — the title/subtitle live in the sticky TopHeader,
            declared via usePageHeader above. */}
        <PageActionRow
          action={
            <button
              onClick={() => setShowModal(true)}
              className="flex items-center gap-2 px-6 py-3 bg-status-error hover:bg-status-error/90 text-text-on-brand rounded-[--radius-button] hover:shadow-lg transition-all cursor-pointer"
            >
              <Plus size={20} />
              Create discipline
            </button>
          }
        />

        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-gradient-to-br from-status-error to-status-error/85 rounded-[--radius-card] p-6 text-text-on-brand"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-text-on-brand/80 text-sm">Total discipline</p>
                <p className="text-4xl font-bold mt-2">{stats.total}</p>
              </div>
              <div className="w-16 h-16 bg-white/20 rounded-[--radius-button] flex items-center justify-center">
                <AlertTriangle size={32} />
              </div>
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="bg-gradient-to-br from-status-warning to-status-warning/85 rounded-[--radius-card] p-6 text-text-on-brand"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-text-on-brand/80 text-sm">Total fine</p>
                <p className="text-3xl font-bold mt-2">{formatCurrency(stats.totalFines)}</p>
              </div>
              <div className="w-16 h-16 bg-white/20 rounded-[--radius-button] flex items-center justify-center">
                <CurrencyIcon size={32} />
              </div>
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="bg-gradient-to-br from-status-info to-status-info/85 rounded-[--radius-card] p-6 text-text-on-brand"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-text-on-brand/80 text-sm">This month</p>
                <p className="text-4xl font-bold mt-2">{stats.thisMonth}</p>
              </div>
              <div className="w-16 h-16 bg-white/20 rounded-[--radius-button] flex items-center justify-center">
                <TrendingDown size={32} />
              </div>
            </div>
          </motion.div>
        </div>

        {/* Filters */}
        <div className="bg-surface-card rounded-[--radius-card] p-6 border border-surface-border">
          <div className="flex flex-col md:flex-row gap-4">
            <div className="flex-1 relative">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-text-muted" size={20} />
              <input
                type="text"
                placeholder="Search by employee name or reason..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-12 pr-4 py-3 border border-surface-border bg-surface-card text-text-body rounded-[--radius-input] focus:outline-none focus:ring-2 focus:ring-status-error/20"
              />
            </div>
            <div className="flex items-center gap-2">
              <Filter size={20} className="text-text-muted" />
              <select
                value={filterType}
                onChange={(e) => setFilterType(e.target.value as DisciplineType | 'ALL')}
                className="px-4 py-3 border border-surface-border bg-surface-card text-text-body rounded-[--radius-input] focus:outline-none focus:ring-2 focus:ring-status-error/20"
              >
                <option value="ALL">All types</option>
                {Object.entries(disciplineTypeLabels).map(([key, label]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Disciplines List */}
        <div className="bg-surface-card rounded-[--radius-card] border border-surface-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-surface-page border-b border-surface-border">
                <tr>
                  <th className="px-6 py-4 text-left text-sm font-semibold text-text-heading">Employee</th>
                  <th className="px-6 py-4 text-left text-sm font-semibold text-text-heading">Reason</th>
                  <th className="px-6 py-4 text-left text-sm font-semibold text-text-heading">Type</th>
                  <th className="px-6 py-4 text-left text-sm font-semibold text-text-heading">Fine amount</th>
                  <th className="px-6 py-4 text-left text-sm font-semibold text-text-heading">Day</th>
                  <th className="px-6 py-4 text-center text-sm font-semibold text-text-heading">Operation</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border-light">
                {filteredDisciplines.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-6 py-12 text-center text-text-muted">
                      There is no discipline
                    </td>
                  </tr>
                ) : (
                  filteredDisciplines.map((discipline) => (
                    <tr key={discipline.id} className="hover:bg-surface-page transition-colors">
                      <td className="px-6 py-4">
                        <div>
                          <p className="font-medium text-brand-primary">{discipline.employee?.fullName}</p>
                          <p className="text-sm text-text-muted">{discipline.employee?.employeeCode}</p>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <p className="text-sm text-text-body">{discipline.reason}</p>
                      </td>
                      <td className="px-6 py-4">
                        <span className={`px-3 py-1 rounded-[--radius-badge] text-xs font-semibold ${disciplineTypeColors[discipline.disciplineType]}`}>
                          {disciplineTypeLabels[discipline.disciplineType]}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <p className="font-bold text-status-error">{formatCurrency(Number(discipline.amount))}</p>
                      </td>
                      <td className="px-6 py-4">
                        <p className="text-sm text-text-body">{formatDate(discipline.disciplineDate)}</p>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center justify-center gap-2">
                          <button
                            onClick={() => handleDelete(discipline.id)}
                            className="p-2 hover:bg-status-error-bg/30 rounded-[--radius-button] text-status-error transition-colors cursor-pointer"
                          >
                            <Trash2 size={18} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Create Modal */}
        {showModal && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              className="bg-surface-card rounded-[--radius-card] p-8 max-w-2xl w-full max-h-[90vh] overflow-y-auto"
            >
              <h3 className="text-2xl font-bold text-text-heading mb-6">Create new discipline</h3>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-text-body mb-2">
                    Employee <span className="text-red-500">*</span>
                  </label>
                  <select
                    value={formData.employeeId}
                    onChange={(e) => setFormData({ ...formData, employeeId: e.target.value })}
                    className="w-full px-4 py-3 border border-surface-border bg-surface-card text-text-body rounded-[--radius-input] focus:outline-none focus:ring-2 focus:ring-status-error/20"
                  >
                    <option value="">Select employee</option>
                    {employees.map((emp) => (
                      <option key={emp.id} value={emp.id}>
                        {emp.employeeCode} - {emp.fullName}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-text-body mb-2">
                    Discipline type <span className="text-red-500">*</span>
                  </label>
                  <select
                    value={formData.disciplineType}
                    onChange={(e) => setFormData({ ...formData, disciplineType: e.target.value as DisciplineType })}
                    className="w-full px-4 py-3 border border-surface-border bg-surface-card text-text-body rounded-[--radius-input] focus:outline-none focus:ring-2 focus:ring-status-error/20"
                  >
                    {Object.entries(disciplineTypeLabels).map(([key, label]) => (
                      <option key={key} value={key}>{label}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-text-body mb-2">
                    Reason <span className="text-red-500">*</span>
                  </label>
                  <textarea
                    value={formData.reason}
                    onChange={(e) => setFormData({ ...formData, reason: e.target.value })}
                    rows={3}
                    className="w-full px-4 py-3 border border-surface-border bg-surface-card text-text-body rounded-[--radius-input] focus:outline-none focus:ring-2 focus:ring-status-error/20"
                    placeholder="Enter reason for discipline..."
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-text-body mb-2">
                    Fine amount
                  </label>
                  <input
                    type="number"
                    value={formData.amount}
                    onChange={(e) => setFormData({ ...formData, amount: Number(e.target.value) || 0 })}
                    min="0"
                    step="1000"
                    className="w-full px-4 py-3 border border-surface-border bg-surface-card text-text-body rounded-[--radius-input] focus:outline-none focus:ring-2 focus:ring-status-error/20"
                    placeholder="Enter amount (if any)"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-text-body mb-2">
                    Discipline day <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="date"
                    value={formData.disciplineDate}
                    onChange={(e) => setFormData({ ...formData, disciplineDate: e.target.value })}
                    className="w-full px-4 py-3 border border-surface-border bg-surface-card text-text-body rounded-[--radius-input] focus:outline-none focus:ring-2 focus:ring-status-error/20"
                  />
                </div>
              </div>

              <div className="flex gap-4 mt-6">
                <button
                  onClick={handleCreate}
                  className="flex-1 px-6 py-3 bg-status-error hover:bg-status-error/90 text-text-on-brand rounded-[--radius-button] font-semibold hover:shadow-lg transition-all cursor-pointer"
                >
                  Create discipline
                </button>
                <button
                  onClick={() => setShowModal(false)}
                  className="px-6 py-3 border border-surface-border text-text-body rounded-[--radius-button] hover:bg-surface-page transition-colors cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </div>
    </>
  );
}

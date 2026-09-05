'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from '@/lib/toast';
import { useConfirm } from '@/hooks/useConfirm';
import { usePageHeader } from '@/hooks/usePageHeader';
import PageActionRow from '@/components/common/PageActionRow';
import { Plus, Award, TrendingUp, Trash2, Search, Filter, Eye } from 'lucide-react';
import { CurrencyIcon } from '@/components/common/CurrencyIcon';
import { motion } from 'framer-motion';
import rewardService, { Reward } from '@/services/rewardService';
import employeeService from '@/services/employeeService';
import { Employee } from '@/types/employee';
import { formatDate, formatCurrency } from '@/utils/formatters';

const rewardTypeLabels: Record<string, string> = {
  BONUS: 'Cash Bonus',
  CERTIFICATE: 'Certificate',
  PROMOTION: 'Promote',
  OTHER: 'Other',
};

const rewardTypeColors: Record<string, string> = {
  BONUS: 'bg-status-success-bg text-status-success',
  CERTIFICATE: 'bg-status-info-bg text-status-info',
  PROMOTION: 'bg-brand-accent/10 text-brand-accent',
  OTHER: 'bg-surface-border-light text-text-muted',
};

export default function RewardsPage() {
  const router = useRouter();

  // The one heading for this route, rendered by TopHeader. Declared before the
  // loading early return so the hook order never changes.
  usePageHeader('Reward management', 'Monitor and manage employee rewards');

  const [rewards, setRewards] = useState<Reward[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterType, setFilterType] = useState<string>('ALL');
  const { confirm, ConfirmDialog, closeModal, setLoading: setConfirmLoading } = useConfirm();

  const [formData, setFormData] = useState({
    employeeId: '',
    reason: '',
    rewardType: 'BONUS' as 'BONUS' | 'CERTIFICATE' | 'PROMOTION' | 'OTHER',
    amount: 0,
    rewardDate: new Date().toISOString().split('T')[0],
  });

  const [stats, setStats] = useState({
    total: 0,
    totalAmount: 0,
    thisMonth: 0,
  });

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      setLoading(true);
      const [rewardsRes, employeesRes] = await Promise.all([
        rewardService.getAll(),
        employeeService.getAll({ status: 'ACTIVE' }),
      ]);

      setRewards(rewardsRes.data);
      setEmployees(employeesRes.data);

      // Calculate stats
      const total = rewardsRes.data.length;
      const totalAmount = rewardsRes.data.reduce((sum: number, r: Reward) => sum + Number(r.amount), 0);
      const thisMonth = rewardsRes.data.filter((r: Reward) => {
        const date = new Date(r.rewardDate);
        const now = new Date();
        return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
      }).length;

      setStats({ total, totalAmount, thisMonth });
    } catch (error) {
      console.error('Unable to load data:', error);
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

    try {
      await rewardService.create(formData);
      toast.success('Create rewards for success');
      setShowModal(false);
      setFormData({
        employeeId: '',
        reason: '',
        rewardType: 'BONUS',
        amount: 0,
        rewardDate: new Date().toISOString().split('T')[0],
      });
      fetchData();
    } catch (error: any) {
      console.error('Unable to create reward:', error);
      let errorMessage = 'Create rewards for failure';

      if (error?.message) {
        errorMessage = error.message;
      } else if (error?.response?.data?.message) {
        errorMessage = error.response.data.message;
      } else if (typeof error === 'string') {
        errorMessage = error;
      }

      toast.error(errorMessage);
    }
  };

  const handleDelete = async (id: string) => {
    const confirmed = await confirm({
      title: 'Confirm deletion',
      message: 'Are you sure you want to delete this reward? This action cannot be undone.',
      confirmText: 'Delete',
      type: 'danger',
    });

    if (!confirmed) return;

    try {
      setConfirmLoading(true);
      await rewardService.delete(id);
      closeModal();
      toast.success('Deleted successfully');
      fetchData();
    } catch (error: any) {
      console.error('Cannot delete:', error);
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

  const filteredRewards = rewards.filter((reward) => {
    const matchSearch = reward.employee?.fullName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      reward.reason.toLowerCase().includes(searchTerm.toLowerCase());
    const matchType = filterType === 'ALL' || reward.rewardType === filterType;
    return matchSearch && matchType;
  });

  if (loading) {
    return (
      <>
        <ConfirmDialog />
        <div className="animate-pulse space-y-6">
          <div className="h-8 bg-slate-200 rounded w-64"></div>
          <div className="grid grid-cols-3 gap-6">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-32 bg-slate-100 rounded-[--radius-card]"></div>
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
              className="flex items-center gap-2 px-5 py-2.5 bg-brand-primary hover:bg-brand-primary-dark text-text-on-brand rounded-[--radius-card] hover:shadow-2xl hover:scale-105 transition-all font-semibold shadow-lg"
            >
              <Plus size={20} />
              Create rewards
            </button>
          }
        />

        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-gradient-to-br from-status-success to-status-success/85 rounded-[--radius-card] p-6 text-white"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-white/80 text-sm">Total reward</p>
                <p className="text-4xl font-bold mt-2">{stats.total}</p>
              </div>
              <div className="w-16 h-16 bg-surface-card/20 rounded-[--radius-card] flex items-center justify-center">
                <Award size={32} />
              </div>
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="bg-gradient-to-br from-brand-primary to-brand-primary/85 rounded-[--radius-card] p-6 text-white"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-white/80 text-sm">Total bonus</p>
                <p className="text-3xl font-bold mt-2">{formatCurrency(stats.totalAmount)}</p>
              </div>
              <div className="w-16 h-16 bg-surface-card/20 rounded-[--radius-card] flex items-center justify-center">
                <CurrencyIcon size={32} />
              </div>
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="bg-gradient-to-br from-brand-accent to-brand-accent/85 rounded-[--radius-card] p-6 text-white"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-white/80 text-sm">This month</p>
                <p className="text-4xl font-bold mt-2">{stats.thisMonth}</p>
              </div>
              <div className="w-16 h-16 bg-surface-card/20 rounded-[--radius-card] flex items-center justify-center">
                <TrendingUp size={32} />
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
                className="w-full pl-12 pr-4 py-3 border border-surface-border rounded-[--radius-card] focus:outline-none focus:ring-2 focus:ring-brand-primary/20 bg-surface-card text-text-body"
              />
            </div>
            <div className="flex items-center gap-2">
              <Filter size={20} className="text-text-muted" />
              <select
                value={filterType}
                onChange={(e) => setFilterType(e.target.value)}
                className="px-4 py-3 border border-surface-border rounded-[--radius-card] focus:outline-none focus:ring-2 focus:ring-brand-primary/20 bg-surface-card text-text-body cursor-pointer"
              >
                <option value="ALL">All types</option>
                {Object.entries(rewardTypeLabels).map(([key, label]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Rewards List */}
        <div className="bg-surface-card rounded-[--radius-card] border border-surface-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-surface-page border-b border-surface-border">
                <tr>
                  <th className="px-6 py-4 text-left text-sm font-semibold text-text-body">Employee</th>
                  <th className="px-6 py-4 text-left text-sm font-semibold text-text-body">Departments</th>
                  <th className="px-6 py-4 text-left text-sm font-semibold text-text-body">Reason</th>
                  <th className="px-6 py-4 text-left text-sm font-semibold text-text-body">Type</th>
                  <th className="px-6 py-4 text-left text-sm font-semibold text-text-body">Amount</th>
                  <th className="px-6 py-4 text-left text-sm font-semibold text-text-body">Day</th>
                  <th className="px-6 py-4 text-center text-sm font-semibold text-text-body">Operation</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border-light">
                {filteredRewards.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-6 py-12 text-center text-text-muted">
                      <Award size={48} className="text-text-muted/40 mx-auto mb-3" />
                      <p className="font-medium">There are no rewards yet</p>
                    </td>
                  </tr>
                ) : (
                  filteredRewards.map((reward) => (
                    <tr key={reward.id} className="hover:bg-surface-page transition-colors">
                      <td className="px-6 py-4">
                        <button
                          onClick={() => router.push(`/dashboard/employees/${reward.employee.id}`)}
                          className="text-left hover:text-brand-primary transition-colors"
                        >
                          <p className="font-medium text-text-heading">{reward.employee?.fullName}</p>
                          <p className="text-sm text-text-muted">{reward.employee?.employeeCode}</p>
                        </button>
                      </td>
                      <td className="px-6 py-4 text-sm text-text-body">
                        {reward.employee?.department?.name || '-'}
                      </td>
                      <td className="px-6 py-4 text-sm text-text-body">{reward.reason}</td>
                      <td className="px-6 py-4">
                        <span className={`px-3 py-1 rounded-[--radius-badge] text-xs font-semibold ${rewardTypeColors[reward.rewardType]}`}>
                          {rewardTypeLabels[reward.rewardType]}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <p className="font-bold text-status-success">{formatCurrency(Number(reward.amount))}</p>
                      </td>
                      <td className="px-6 py-4">
                        <p className="text-sm text-text-body">{formatDate(reward.rewardDate)}</p>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center justify-center gap-2">
                          <button
                            onClick={() => router.push(`/dashboard/employees/${reward.employee.id}`)}
                            className="p-2 hover:bg-brand-primary-light/20 rounded-[--radius-button] text-brand-primary transition-colors"
                            title="See staff"
                          >
                            <Eye size={18} />
                          </button>
                          <button
                            onClick={() => handleDelete(reward.id)}
                            className="p-2 hover:bg-status-error-bg/30 rounded-[--radius-button] text-status-error transition-colors"
                            title="Delete"
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
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              className="bg-surface-overlay rounded-[--radius-card] p-8 max-w-2xl w-full max-h-[90vh] overflow-y-auto shadow-2xl"
            >
              <h3 className="text-2xl font-bold text-text-heading mb-6">Create new rewards</h3>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-text-body mb-2">
                    Employee <span className="text-status-error">*</span>
                  </label>
                  <select
                    value={formData.employeeId}
                    onChange={(e) => setFormData({ ...formData, employeeId: e.target.value })}
                    className="w-full px-4 py-3 border border-surface-border rounded-[--radius-card] focus:outline-none focus:ring-2 focus:ring-brand-primary/20 bg-surface-card text-text-body cursor-pointer"
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
                    Type of reward <span className="text-status-error">*</span>
                  </label>
                  <select
                    value={formData.rewardType}
                    onChange={(e) => setFormData({ ...formData, rewardType: e.target.value as any })}
                    className="w-full px-4 py-3 border border-surface-border rounded-[--radius-card] focus:outline-none focus:ring-2 focus:ring-brand-primary/20 bg-surface-card text-text-body cursor-pointer"
                  >
                    {Object.entries(rewardTypeLabels).map(([key, label]) => (
                      <option key={key} value={key}>{label}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-text-body mb-2">
                    Reason <span className="text-status-error">*</span>
                  </label>
                  <textarea
                    value={formData.reason}
                    onChange={(e) => setFormData({ ...formData, reason: e.target.value })}
                    rows={3}
                    className="w-full px-4 py-3 border border-surface-border rounded-[--radius-card] focus:outline-none focus:ring-2 focus:ring-brand-primary/20 bg-surface-card text-text-body"
                    placeholder="Enter the reason for the reward..."
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-text-body mb-2">
                    Reward
                  </label>
                  <input
                    type="number"
                    value={formData.amount}
                    onChange={(e) => setFormData({ ...formData, amount: Number(e.target.value) || 0 })}
                    min="0"
                    step="1000"
                    className="w-full px-4 py-3 border border-surface-border rounded-[--radius-card] focus:outline-none focus:ring-2 focus:ring-brand-primary/20 bg-surface-card text-text-body"
                    placeholder="Enter amount (if any)"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-text-body mb-2">
                    Reward day <span className="text-status-error">*</span>
                  </label>
                  <input
                    type="date"
                    value={formData.rewardDate}
                    onChange={(e) => setFormData({ ...formData, rewardDate: e.target.value })}
                    className="w-full px-4 py-3 border border-surface-border rounded-[--radius-card] focus:outline-none focus:ring-2 focus:ring-brand-primary/20 bg-surface-card text-text-body"
                  />
                </div>
              </div>

              <div className="flex gap-4 mt-6">
                <button
                  onClick={handleCreate}
                  className="flex-1 px-6 py-3 bg-brand-primary hover:bg-brand-primary-dark text-text-on-brand rounded-[--radius-card] font-semibold hover:shadow-lg transition-all"
                >
                  Create rewards
                </button>
                <button
                  onClick={() => setShowModal(false)}
                  className="px-6 py-3 border border-surface-border text-text-body rounded-[--radius-card] hover:bg-surface-page transition-colors"
                >
                  Cancel
                </button>
              </div>
            </motion.div>
          </div>
        )}

        {/* Info */}
        <div className="bg-status-success-bg border-l-4 border-status-success p-4 rounded-r-[--radius-button]">
          <h4 className="text-sm font-semibold text-status-success mb-2">ℹ️ Note:</h4>
          <ul className="text-sm text-text-body space-y-1 list-disc list-inside">
            <li>Rewards will be automatically calculated into the corresponding monthly salary</li>
            <li>The bonus amount will be ADDED to the total salary</li>
            <li>Only calculate amounts during the pay period (according to bonus date)</li>
            <li>Details can be viewed in the employee's pay slip</li>
          </ul>
        </div>
      </div>
    </>
  );
}

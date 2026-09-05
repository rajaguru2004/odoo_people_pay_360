'use client';

import { useEffect, useState } from 'react';
import { Plus, Award, AlertTriangle, TrendingUp, TrendingDown } from 'lucide-react';
import { formatCurrency, getCompanyTz } from '@/utils/formatters';
import { toast } from '@/lib/toast';
import rewardService, { Reward } from '@/services/rewardService';
import disciplineService, { Discipline } from '@/services/disciplineService';
import employeeService from '@/services/employeeService';
import { Employee } from '@/types/employee';
import { useAuthStore } from '@/store/authStore';
import { usePageHeader } from '@/hooks/usePageHeader';
import PageActionRow from '@/components/common/PageActionRow';

const rewardTypeLabels: Record<string, string> = {
    BONUS: 'Cash Bonus',
    CERTIFICATE: 'Certificate',
    PROMOTION: 'Promote',
    OTHER: 'Other',
};

const disciplineTypeLabels: Record<string, string> = {
    WARNING: 'Warning',
    FINE: 'Fine',
    DEMOTION: 'Demotion',
    TERMINATION: 'Termination',
};

export default function RewardsDisciplinesPage() {
    const { user } = useAuthStore();

    // The one heading for this route, rendered by TopHeader.
    usePageHeader('Rewards & Penalties', 'Managing employee rewards and discipline');

    const [rewards, setRewards] = useState<Reward[]>([]);
    const [disciplines, setDisciplines] = useState<Discipline[]>([]);
    const [employees, setEmployees] = useState<Employee[]>([]);
    const [loading, setLoading] = useState(true);
    const [selectedTab, setSelectedTab] = useState<'rewards' | 'disciplines'>('rewards');
    const [showModal, setShowModal] = useState(false);
    const [saving, setSaving] = useState(false);

    const [rewardForm, setRewardForm] = useState({
        employeeId: '',
        reason: '',
        rewardType: 'BONUS' as 'BONUS' | 'CERTIFICATE' | 'PROMOTION' | 'OTHER',
        amount: 0,
        rewardDate: new Date().toISOString().split('T')[0],
    });

    const [disciplineForm, setDisciplineForm] = useState({
        employeeId: '',
        reason: '',
        disciplineType: 'WARNING' as 'WARNING' | 'FINE' | 'DEMOTION' | 'TERMINATION',
        amount: 0,
        disciplineDate: new Date().toISOString().split('T')[0],
    });

    useEffect(() => {
        fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user]);

    const fetchData = async () => {
        try {
            setLoading(true);
            const isEmployee = user?.role === 'EMPLOYEE';
            const employeeId = user?.employeeId || user?.employee?.id;

            let rewardsData: Reward[] = [];
            let disciplinesData: Discipline[] = [];

            if (isEmployee && employeeId) {
                // Employees can only see their own rewards/disciplines
                const [rewardsRes, disciplinesRes] = await Promise.all([
                    rewardService.getByEmployee(employeeId),
                    disciplineService.getByEmployee(employeeId),
                ]);
                rewardsData = Array.isArray(rewardsRes.data) ? rewardsRes.data : [];
                disciplinesData = Array.isArray(disciplinesRes.data) ? disciplinesRes.data : [];
            } else {
                // Admin / HR / Manager see all
                const [rewardsRes, disciplinesRes, employeesRes] = await Promise.all([
                    rewardService.getAll({ page: 1, limit: 200 }),
                    disciplineService.getAll({ page: 1, limit: 200 }),
                    employeeService.getAll({ status: 'ACTIVE' }),
                ]);
                rewardsData = Array.isArray(rewardsRes.data) ? rewardsRes.data : [];
                disciplinesData = Array.isArray(disciplinesRes.data) ? disciplinesRes.data : [];
                setEmployees(Array.isArray(employeesRes.data) ? employeesRes.data : []);
            }

            setRewards(rewardsData);
            setDisciplines(disciplinesData);
        } catch (error: any) {
            console.error('Unable to load data:', error?.message || error);
        } finally {
            setLoading(false);
        }
    };

    const canCreate = user?.role !== 'EMPLOYEE';

    const handleCreate = async () => {
        setSaving(true);
        try {
            if (selectedTab === 'rewards') {
                if (!rewardForm.employeeId || !rewardForm.reason) {
                    toast.warning('Please fill in all required fields');
                    return;
                }
                await rewardService.create(rewardForm);
                toast.success('Reward created successfully');
                setRewardForm({
                    employeeId: '',
                    reason: '',
                    rewardType: 'BONUS',
                    amount: 0,
                    rewardDate: new Date().toISOString().split('T')[0],
                });
            } else {
                if (!disciplineForm.employeeId || !disciplineForm.reason) {
                    toast.warning('Please fill in all required fields');
                    return;
                }
                await disciplineService.create(disciplineForm);
                toast.success('Discipline record created successfully');
                setDisciplineForm({
                    employeeId: '',
                    reason: '',
                    disciplineType: 'WARNING',
                    amount: 0,
                    disciplineDate: new Date().toISOString().split('T')[0],
                });
            }
            setShowModal(false);
            fetchData();
        } catch (error: any) {
            const message = error?.response?.data?.message || error?.message || 'Unable to create record';
            toast.error(message);
        } finally {
            setSaving(false);
        }
    };

    const stats = {
        totalRewards: rewards.length,
        totalRewardAmount: rewards.reduce((sum, r) => sum + Number(r.amount), 0),
        totalDisciplines: disciplines.length,
        totalDisciplineAmount: disciplines.reduce((sum, d) => sum + Number(d.amount), 0),
    };

    return (
        <>
            <div className="space-y-6">
                {/* Action only — the title/subtitle live in the sticky TopHeader,
                    declared via usePageHeader above. */}
                <PageActionRow
                    action={
                        canCreate ? (
                            <button
                                onClick={() => setShowModal(true)}
                                className="flex items-center gap-2 px-5 py-2.5 bg-brand-primary hover:bg-brand-primary-dark text-text-on-brand rounded-[--radius-button] transition-all font-semibold shadow-md cursor-pointer"
                            >
                                <Plus size={20} />
                                Add New
                            </button>
                        ) : null
                    }
                />

                {/* Stats */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                    <div className="bg-surface-card rounded-[--radius-card] p-6 border border-status-success/20">
                        <div className="flex items-center gap-3 mb-2">
                            <div className="w-10 h-10 bg-status-success-bg rounded-[--radius-button] flex items-center justify-center">
                                <Award className="text-status-success" size={20} />
                            </div>
                            <p className="text-sm text-text-muted">Total reward</p>
                        </div>
                        <p className="text-3xl font-bold text-status-success">{stats.totalRewards}</p>
                    </div>

                    <div className="bg-gradient-to-br from-status-success to-status-success/80 rounded-[--radius-card] p-6 text-white">
                        <div className="flex items-center gap-3 mb-2">
                            <div className="w-10 h-10 bg-white/20 rounded-[--radius-button] flex items-center justify-center">
                                <TrendingUp size={20} />
                            </div>
                            <p className="text-sm text-white/80">Total bonus</p>
                        </div>
                        <p className="text-2xl font-bold">{formatCurrency(stats.totalRewardAmount)}</p>
                    </div>

                    <div className="bg-surface-card rounded-[--radius-card] p-6 border border-status-error/20">
                        <div className="flex items-center gap-3 mb-2">
                            <div className="w-10 h-10 bg-status-error-bg rounded-[--radius-button] flex items-center justify-center">
                                <AlertTriangle className="text-status-error" size={20} />
                            </div>
                            <p className="text-sm text-text-muted">Disciplinary actions</p>
                        </div>
                        <p className="text-3xl font-bold text-status-error">{stats.totalDisciplines}</p>
                    </div>

                    <div className="bg-gradient-to-br from-status-error to-status-error/80 rounded-[--radius-card] p-6 text-white">
                        <div className="flex items-center gap-3 mb-2">
                            <div className="w-10 h-10 bg-white/20 rounded-[--radius-button] flex items-center justify-center">
                                <TrendingDown size={20} />
                            </div>
                            <p className="text-sm text-white/80">Total fine</p>
                        </div>
                        <p className="text-2xl font-bold">{formatCurrency(stats.totalDisciplineAmount)}</p>
                    </div>
                </div>

                {/* Tabs */}
                <div className="bg-surface-card rounded-[--radius-card] border border-surface-border">
                    <div className="border-b border-surface-border">
                        <div className="flex gap-4 px-6">
                            <button
                                onClick={() => setSelectedTab('rewards')}
                                className={`py-4 px-4 font-semibold border-b-2 transition-colors flex items-center gap-2 ${selectedTab === 'rewards'
                                    ? 'border-status-success text-status-success'
                                    : 'border-transparent text-text-muted hover:text-text-body'
                                    }`}
                            >
                                <Award size={18} />
                                Commendation ({stats.totalRewards})
                            </button>
                            <button
                                onClick={() => setSelectedTab('disciplines')}
                                className={`py-4 px-4 font-semibold border-b-2 transition-colors flex items-center gap-2 ${selectedTab === 'disciplines'
                                    ? 'border-status-error text-status-error'
                                    : 'border-transparent text-text-muted hover:text-text-body'
                                    }`}
                            >
                                <AlertTriangle size={18} />
                                Discipline ({stats.totalDisciplines})
                            </button>
                        </div>
                    </div>

                    {/* Rewards Table */}
                    {selectedTab === 'rewards' && (
                        <div className="overflow-x-auto">
                            <table className="w-full">
                                <thead className="bg-surface-page border-b border-surface-border">
                                    <tr>
                                        <th className="px-6 py-4 text-left text-sm font-semibold text-text-muted">Employee</th>
                                        <th className="px-6 py-4 text-left text-sm font-semibold text-text-muted">Departments</th>
                                        <th className="px-6 py-4 text-left text-sm font-semibold text-text-muted">Reason</th>
                                        <th className="px-6 py-4 text-center text-sm font-semibold text-text-muted">Type</th>
                                        <th className="px-6 py-4 text-right text-sm font-semibold text-text-muted">Amount</th>
                                        <th className="px-6 py-4 text-center text-sm font-semibold text-text-muted">Day</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-surface-border-light">
                                    {loading ? (
                                        <tr>
                                            <td colSpan={6} className="px-6 py-12 text-center">
                                                <div className="flex items-center justify-center">
                                                    <div className="w-8 h-8 border-4 border-brand-primary border-t-transparent rounded-full animate-spin"></div>
                                                </div>
                                            </td>
                                        </tr>
                                    ) : rewards.length === 0 ? (
                                        <tr>
                                            <td colSpan={6} className="px-6 py-12 text-center">
                                                <Award size={48} className="text-text-muted mx-auto mb-3" />
                                                <p className="text-text-muted font-medium">There are no rewards yet</p>
                                            </td>
                                        </tr>
                                    ) : (
                                        rewards.map((reward) => (
                                            <tr key={reward.id} className="hover:bg-surface-page/50 transition-colors">
                                                <td className="px-6 py-4">
                                                    <div>
                                                        <p className="font-semibold text-brand-primary">{reward.employee.fullName}</p>
                                                        <p className="text-sm text-text-muted">{reward.employee.employeeCode}</p>
                                                    </div>
                                                </td>
                                                <td className="px-6 py-4 text-sm text-text-body">
                                                    {reward.employee.department?.name || '-'}
                                                </td>
                                                <td className="px-6 py-4 text-sm text-text-body">{reward.reason}</td>
                                                <td className="px-6 py-4 text-center">
                                                    <span className="px-3 py-1 bg-status-success-bg text-status-success rounded-[--radius-badge] text-xs font-medium">
                                                        {reward.rewardType}
                                                    </span>
                                                </td>
                                                <td className="px-6 py-4 text-right">
                                                    <span className="font-bold text-status-success">
                                                        +{formatCurrency(Number(reward.amount))}
                                                    </span>
                                                </td>
                                                <td className="px-6 py-4 text-center text-sm text-text-body">
                                                    {new Date(reward.rewardDate).toLocaleDateString('en-IN', { timeZone: getCompanyTz() })}
                                                </td>
                                            </tr>
                                        ))
                                    )}
                                </tbody>
                            </table>
                        </div>
                    )}

                    {/* Disciplines Table */}
                    {selectedTab === 'disciplines' && (
                        <div className="overflow-x-auto">
                            <table className="w-full">
                                <thead className="bg-surface-page border-b border-surface-border">
                                    <tr>
                                        <th className="px-6 py-4 text-left text-sm font-semibold text-text-muted">Employee</th>
                                        <th className="px-6 py-4 text-left text-sm font-semibold text-text-muted">Departments</th>
                                        <th className="px-6 py-4 text-left text-sm font-semibold text-text-muted">Reason</th>
                                        <th className="px-6 py-4 text-center text-sm font-semibold text-text-muted">Type</th>
                                        <th className="px-6 py-4 text-right text-sm font-semibold text-text-muted">Amount</th>
                                        <th className="px-6 py-4 text-center text-sm font-semibold text-text-muted">Day</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-surface-border-light">
                                    {loading ? (
                                        <tr>
                                            <td colSpan={6} className="px-6 py-12 text-center">
                                                <div className="flex items-center justify-center">
                                                    <div className="w-8 h-8 border-4 border-brand-primary border-t-transparent rounded-full animate-spin"></div>
                                                </div>
                                            </td>
                                        </tr>
                                    ) : disciplines.length === 0 ? (
                                        <tr>
                                            <td colSpan={6} className="px-6 py-12 text-center">
                                                <AlertTriangle size={48} className="text-text-muted mx-auto mb-3" />
                                                <p className="text-text-muted font-medium">There is no discipline yet</p>
                                            </td>
                                        </tr>
                                    ) : (
                                        disciplines.map((discipline) => (
                                            <tr key={discipline.id} className="hover:bg-surface-page/50 transition-colors">
                                                <td className="px-6 py-4">
                                                    <div>
                                                        <p className="font-semibold text-brand-primary">{discipline.employee.fullName}</p>
                                                        <p className="text-sm text-text-muted">{discipline.employee.employeeCode}</p>
                                                    </div>
                                                </td>
                                                <td className="px-6 py-4 text-sm text-text-body">
                                                    {discipline.employee.department?.name || '-'}
                                                </td>
                                                <td className="px-6 py-4 text-sm text-text-body">{discipline.reason}</td>
                                                <td className="px-6 py-4 text-center">
                                                    <span className="px-3 py-1 bg-status-error-bg text-status-error rounded-[--radius-badge] text-xs font-medium">
                                                        {discipline.disciplineType}
                                                    </span>
                                                </td>
                                                <td className="px-6 py-4 text-right">
                                                    <span className="font-bold text-status-error">
                                                        -{formatCurrency(Number(discipline.amount))}
                                                    </span>
                                                </td>
                                                <td className="px-6 py-4 text-center text-sm text-text-body">
                                                    {new Date(discipline.disciplineDate).toLocaleDateString('en-IN', { timeZone: getCompanyTz() })}
                                                </td>
                                            </tr>
                                        ))
                                    )}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>

                {/* Info */}
                <div className="bg-brand-primary-light/10 border-l-4 border-brand-primary p-4 rounded-r-[--radius-button]">
                    <h4 className="text-sm font-semibold text-brand-primary mb-2">ℹ️ Note:</h4>
                    <ul className="text-sm text-text-body space-y-1 list-disc list-inside">
                        <li>Bonuses and penalties will be calculated into the corresponding monthly payroll</li>
                        <li>Bonus will be ADDED to salary, penalty will be SUBTRACT from salary</li>
                        <li>Only calculate amounts within the pay period (according to bonus/penalty dates)</li>
                        <li>Details can be viewed in the employee's pay slip</li>
                    </ul>
                </div>
            </div>

            {/* Create Modal */}
            {showModal && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                    <div className="bg-surface-overlay rounded-[--radius-card] p-8 max-w-2xl w-full max-h-[90vh] overflow-y-auto shadow-2xl">
                        <h3 className="text-2xl font-bold text-text-heading mb-6">
                            {selectedTab === 'rewards' ? 'Add new reward' : 'Add new discipline record'}
                        </h3>

                        {selectedTab === 'rewards' ? (
                            <div className="space-y-4">
                                <div>
                                    <label className="block text-sm font-medium text-text-body mb-2">
                                        Employee <span className="text-status-error">*</span>
                                    </label>
                                    <select
                                        value={rewardForm.employeeId}
                                        onChange={(e) => setRewardForm({ ...rewardForm, employeeId: e.target.value })}
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
                                        value={rewardForm.rewardType}
                                        onChange={(e) => setRewardForm({ ...rewardForm, rewardType: e.target.value as any })}
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
                                        value={rewardForm.reason}
                                        onChange={(e) => setRewardForm({ ...rewardForm, reason: e.target.value })}
                                        rows={3}
                                        className="w-full px-4 py-3 border border-surface-border rounded-[--radius-card] focus:outline-none focus:ring-2 focus:ring-brand-primary/20 bg-surface-card text-text-body"
                                        placeholder="Enter the reason for the reward..."
                                    />
                                </div>

                                <div>
                                    <label className="block text-sm font-medium text-text-body mb-2">Amount</label>
                                    <input
                                        type="number"
                                        value={rewardForm.amount}
                                        onChange={(e) => setRewardForm({ ...rewardForm, amount: Number(e.target.value) || 0 })}
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
                                        value={rewardForm.rewardDate}
                                        onChange={(e) => setRewardForm({ ...rewardForm, rewardDate: e.target.value })}
                                        className="w-full px-4 py-3 border border-surface-border rounded-[--radius-card] focus:outline-none focus:ring-2 focus:ring-brand-primary/20 bg-surface-card text-text-body"
                                    />
                                </div>
                            </div>
                        ) : (
                            <div className="space-y-4">
                                <div>
                                    <label className="block text-sm font-medium text-text-body mb-2">
                                        Employee <span className="text-status-error">*</span>
                                    </label>
                                    <select
                                        value={disciplineForm.employeeId}
                                        onChange={(e) => setDisciplineForm({ ...disciplineForm, employeeId: e.target.value })}
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
                                        Type of discipline <span className="text-status-error">*</span>
                                    </label>
                                    <select
                                        value={disciplineForm.disciplineType}
                                        onChange={(e) => setDisciplineForm({ ...disciplineForm, disciplineType: e.target.value as any })}
                                        className="w-full px-4 py-3 border border-surface-border rounded-[--radius-card] focus:outline-none focus:ring-2 focus:ring-brand-primary/20 bg-surface-card text-text-body cursor-pointer"
                                    >
                                        {Object.entries(disciplineTypeLabels).map(([key, label]) => (
                                            <option key={key} value={key}>{label}</option>
                                        ))}
                                    </select>
                                </div>

                                <div>
                                    <label className="block text-sm font-medium text-text-body mb-2">
                                        Reason <span className="text-status-error">*</span>
                                    </label>
                                    <textarea
                                        value={disciplineForm.reason}
                                        onChange={(e) => setDisciplineForm({ ...disciplineForm, reason: e.target.value })}
                                        rows={3}
                                        className="w-full px-4 py-3 border border-surface-border rounded-[--radius-card] focus:outline-none focus:ring-2 focus:ring-brand-primary/20 bg-surface-card text-text-body"
                                        placeholder="Enter the reason for the discipline..."
                                    />
                                </div>

                                <div>
                                    <label className="block text-sm font-medium text-text-body mb-2">Amount</label>
                                    <input
                                        type="number"
                                        value={disciplineForm.amount}
                                        onChange={(e) => setDisciplineForm({ ...disciplineForm, amount: Number(e.target.value) || 0 })}
                                        min="0"
                                        step="1000"
                                        className="w-full px-4 py-3 border border-surface-border rounded-[--radius-card] focus:outline-none focus:ring-2 focus:ring-brand-primary/20 bg-surface-card text-text-body"
                                        placeholder="Enter amount (if any)"
                                    />
                                </div>

                                <div>
                                    <label className="block text-sm font-medium text-text-body mb-2">
                                        Discipline day <span className="text-status-error">*</span>
                                    </label>
                                    <input
                                        type="date"
                                        value={disciplineForm.disciplineDate}
                                        onChange={(e) => setDisciplineForm({ ...disciplineForm, disciplineDate: e.target.value })}
                                        className="w-full px-4 py-3 border border-surface-border rounded-[--radius-card] focus:outline-none focus:ring-2 focus:ring-brand-primary/20 bg-surface-card text-text-body"
                                    />
                                </div>
                            </div>
                        )}

                        <div className="flex gap-4 mt-6">
                            <button
                                onClick={handleCreate}
                                disabled={saving}
                                className="flex-1 px-6 py-3 bg-brand-primary hover:bg-brand-primary-dark text-text-on-brand rounded-[--radius-card] font-semibold hover:shadow-lg transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                            >
                                {saving ? 'Saving...' : 'Save'}
                            </button>
                            <button
                                onClick={() => setShowModal(false)}
                                disabled={saving}
                                className="px-6 py-3 border border-surface-border text-text-body rounded-[--radius-card] hover:bg-surface-page transition-colors"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}

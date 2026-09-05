'use client';

import React, { useEffect, useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import PageActionRow from '@/components/common/PageActionRow';
import { usePermission } from '@/hooks/usePermission';
import { usePageHeader } from '@/hooks/usePageHeader';
import { Plus, Edit, Trash2, Users, TrendingUp, X } from 'lucide-react';
import { CurrencyIcon } from '@/components/common/CurrencyIcon';
import { formatCurrency, getCompanyTz } from '@/utils/formatters';
import {
    SALARY_COMPONENT_OPTIONS,
    SalaryComponentTypeOption,
    toComponentCode,
    componentLabel,
    optionsFromLibrary,
} from '@/utils/salaryComponentUtils';
import salaryComponentService, { SalaryComponent, ComponentType } from '@/services/salaryComponentService';
import libraryService from '@/services/libraryService';
import employeeService from '@/services/employeeService';
import { Employee } from '@/types/employee';
import { useConfirm } from '@/hooks/useConfirm';
import { toast } from '@/lib/toast';
import { motion } from 'framer-motion';
import { apiErrorMessage } from '@/utils/apiError';

const getColorForType = (type: string) => {
    const colors = [
        'bg-brand-primary-light/20 text-brand-primary',
        'bg-teal-100 text-teal-700',
        'bg-green-100 text-green-700',
        'bg-purple-100 text-purple-700',
        'bg-orange-100 text-orange-700',
        'bg-pink-100 text-pink-700',
        'bg-brand-primary-light/20 text-brand-primary-dark',
        'bg-yellow-100 text-yellow-700',
    ];
    let hash = 0;
    for (let i = 0; i < type.length; i++) {
        hash = type.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
};

export default function SalaryStructurePage() {
    const t = useTranslations('salaryStructurePage');
    const tc = useTranslations('common');
    const { can, isAdmin } = usePermission();

    // The one heading for this route, rendered by TopHeader.
    usePageHeader(t('title'), t('subtitle'));

    const [components, setComponents] = useState<SalaryComponent[]>([]);
    const [employees, setEmployees] = useState<Employee[]>([]);
    const [loading, setLoading] = useState(true);
    const [selectedType, setSelectedType] = useState<string>('ALL');
    const [showModal, setShowModal] = useState(false);
    const [editingComponent, setEditingComponent] = useState<SalaryComponent | null>(null);
    const [componentTypeOptions, setComponentTypeOptions] = useState<SalaryComponentTypeOption[]>(SALARY_COMPONENT_OPTIONS);
    const { confirm, ConfirmDialog, closeModal, setLoading: setConfirmLoading } = useConfirm();

    const [formData, setFormData] = useState({
        employeeId: '',
        componentType: 'BASIC' as ComponentType,
        amount: 0,
        effectiveDate: new Date().toISOString().split('T')[0],
        note: '',
    });

    useEffect(() => {
        fetchComponents();
        fetchEmployees();
        fetchComponentTypes();
    }, []);

    const fetchComponentTypes = async () => {
        try {
            const response = await libraryService.getAll('SALARY_COMPONENT_TYPE', true);
            const options = optionsFromLibrary(response?.success ? response.data : null);
            setComponentTypeOptions(options);
            setFormData(prev => ({ ...prev, componentType: options[0].value }));
        } catch (error) {
            console.error('Failed to fetch salary types:', error);
            setComponentTypeOptions(SALARY_COMPONENT_OPTIONS);
        }
    };

    const fetchComponents = async () => {
        try {
            setLoading(true);
            // ACTIVE only. An employee's salary structure IS their active
            // components; a retired row explains an older payslip and is not
            // part of what they are paid now. Listing everything meant an
            // amended component appeared twice, at two different amounts, with
            // nothing on screen saying which one applies.
            const response = await salaryComponentService.getAll({
                isActive: true,
                limit: 200,
            });
            setComponents(response.data);
        } catch (error) {
            console.error('Unable to load salary structure:', error);
        } finally {
            setLoading(false);
        }
    };

    const fetchEmployees = async () => {
        try {
            const response = await employeeService.getAll({ status: 'ACTIVE' });
            setEmployees(response.data);
        } catch (error) {
            console.error('Unable to load employees:', error);
        }
    };

    /**
     * The options the modal offers.
     *
     * `componentType` is an OPEN slug on the server and the library is
     * admin-editable, so a stored component can easily hold a type the current
     * library no longer lists — a renamed entry, a retired one, or a code
     * created through the API. The select is `required`, so when nothing matched
     * its value was empty and the browser blocked the submit: the modal opened,
     * Save reacted, and absolutely nothing happened, with no message anywhere.
     *
     * Editing therefore offers the row's own type as well, so an existing
     * component is always editable while new ones still pick from the library.
     */
    const modalTypeOptions = useMemo(() => {
        const current = editingComponent?.componentType;
        if (!current || componentTypeOptions.some((o) => o.value === current)) {
            return componentTypeOptions;
        }
        return [
            ...componentTypeOptions,
            { value: current, label: componentLabel(current, componentTypeOptions) },
        ];
    }, [componentTypeOptions, editingComponent]);

    const filteredComponents = useMemo(() => components.filter(c => {
        if (selectedType === 'ALL') return true;
        if (selectedType === 'ALLOWANCE') {
            return c.componentType.toLowerCase().includes('allowance');
        }
        if (selectedType === 'BASIC') {
            return c.componentType.toLowerCase().includes('basic');
        }
        if (selectedType === 'BONUS') {
            return c.componentType.toLowerCase().includes('bonus');
        }
        return c.componentType === selectedType;
    }), [components, selectedType]);

    // Group components by employee for better display
    const groupedByEmployee = useMemo(() => filteredComponents.reduce((acc, component) => {
        const key = component.employee.id;
        if (!acc[key]) {
            acc[key] = {
                employee: component.employee,
                components: []
            };
        }
        acc[key].components.push(component);
        return acc;
    }, {} as Record<string, { employee: any; components: SalaryComponent[] }>), [filteredComponents]);

    const stats = useMemo(() => ({
        total: components.length,
        basic: components.filter(c => c.componentType.toLowerCase().includes('basic')).length,
        allowance: components.filter(c => c.componentType.toLowerCase().includes('allowance')).length,
        bonus: components.filter(c => c.componentType.toLowerCase().includes('bonus')).length,
        totalAmount: components.reduce((sum, c) => sum + Number(c.amount), 0),
    }), [components]);

    const getTypeBadge = (type: string) => {
        const style = getColorForType(type);

        return (
            <span className={`px-3 py-1 rounded-full text-xs font-medium ${style}`}>
                {componentLabel(type, componentTypeOptions)}
            </span>
        );
    };

    const handleDelete = async (id: string) => {
        const confirmed = await confirm({
            title: t('deleteConfirmTitle'),
            message: t('deleteConfirmMessage'),
            confirmText: tc('delete'),
            type: 'danger',
        });

        if (!confirmed) return;

        try {
            setConfirmLoading(true);
            await salaryComponentService.delete(id);
            closeModal();
            toast.success(t('deleteSuccess'));
            fetchComponents();
        } catch (error: any) {
            console.error('Failed to delete component:', error);
            closeModal();
            toast.error(apiErrorMessage(error) || t('deleteFailedFallback'));
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        if (!formData.employeeId) {
            toast.warning(t('selectEmployeeWarning'));
            return;
        }

        if (formData.amount < 0) {
            toast.warning(t('amountNonNegativeWarning'));
            return;
        }

        try {
            const payloadType = toComponentCode(String(formData.componentType));
            if (editingComponent) {
                await salaryComponentService.update(editingComponent.id, {
                    amount: formData.amount,
                    effectiveDate: formData.effectiveDate,
                    note: formData.note,
                });
                toast.success(t('updateSuccess'));
            } else {
                await salaryComponentService.create({
                    ...formData,
                    componentType: payloadType,
                });
                toast.success(t('createSuccess'));
            }
            setShowModal(false);
            fetchComponents();
        } catch (error: any) {
            console.error('Failed to save component:', error);
            const rawMsg = apiErrorMessage(error);
            const msg = Array.isArray(rawMsg) ? rawMsg.join(', ') : (rawMsg || t('saveFailedFallback'));
            toast.error(msg);
        }
    };

    return (
        <ProtectedRoute requiredPermission="MANAGE_SALARY_COMPONENTS">
            <>
                <ConfirmDialog />
                <div className="space-y-6">
                    <PageActionRow
                        action={can('MANAGE_SALARY_COMPONENTS') && (
                            <button
                                data-testid="sc-add"
                                onClick={() => {
                                    setEditingComponent(null);
                                    setFormData({
                                        employeeId: '',
                                        componentType: componentTypeOptions[0]?.value as ComponentType || 'BASIC',
                                        amount: 0,
                                        effectiveDate: new Date().toISOString().split('T')[0],
                                        note: '',
                                    });
                                    setShowModal(true);
                                }}
                                className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-brand-primary to-brand-primary-dark text-text-on-brand rounded-xl hover:shadow-2xl hover:scale-105 transition-all font-semibold shadow-lg shadow-brand-primary/20"
                            >
                                <Plus size={20} />
                                {t('addComponentBtn')}
                            </button>
                        )}
                    />

                    {/* Stats */}
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                        <div className="bg-surface-card rounded-xl p-6 border-2 border-surface-border">
                            <div className="flex items-center gap-3 mb-2">
                                <div className="w-10 h-10 bg-brand-primary-light/20 rounded-lg flex items-center justify-center">
                                    <Users className="text-brand-primary" size={20} />
                                </div>
                                <p className="text-sm text-text-muted">{t('statTotalComponents')}</p>
                            </div>
                            <p className="text-3xl font-bold text-text-heading">{stats.total}</p>
                        </div>

                        <div className="bg-surface-card rounded-xl p-6 border-2 border-brand-primary-light/35">
                            <div className="flex items-center gap-3 mb-2">
                                <div className="w-10 h-10 bg-brand-primary-light/20 rounded-lg flex items-center justify-center">
                                    <CurrencyIcon className="text-brand-primary" size={20} />
                                </div>
                                <p className="text-sm text-text-muted">{t('statBasicSalary')}</p>
                            </div>
                            <p className="text-3xl font-bold text-brand-primary">{stats.basic}</p>
                        </div>

                        <div className="bg-surface-card rounded-xl p-6 border-2 border-status-success/20">
                            <div className="flex items-center gap-3 mb-2">
                                <div className="w-10 h-10 bg-status-success-bg/40 rounded-lg flex items-center justify-center">
                                    <TrendingUp className="text-status-success" size={20} />
                                </div>
                                <p className="text-sm text-text-muted">{t('statAllowance')}</p>
                            </div>
                            <p className="text-3xl font-bold text-status-success">{stats.allowance}</p>
                        </div>

                        <div className="bg-gradient-to-br from-brand-primary to-brand-primary-dark rounded-xl p-6 text-text-on-brand shadow-lg shadow-brand-primary/10">
                            <div className="flex items-center gap-3 mb-2">
                                <div className="w-10 h-10 bg-white/20 rounded-lg flex items-center justify-center">
                                    <CurrencyIcon size={20} />
                                </div>
                                <p className="text-sm text-text-on-brand/85">{t('statTotalValue')}</p>
                            </div>
                            <p className="text-2xl font-bold">{formatCurrency(stats.totalAmount)}</p>
                        </div>
                    </div>

                    {/* Filters */}
                    <div className="bg-surface-card rounded-2xl border border-surface-border p-6">
                        <div className="flex gap-3">
                            <button
                                onClick={() => setSelectedType('ALL')}
                                className={`px-4 py-2 rounded-lg font-medium transition-colors cursor-pointer ${selectedType === 'ALL'
                                    ? 'bg-brand-primary text-text-on-brand'
                                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                                    }`}
                            >
                                {t('filterAll', { count: stats.total })}
                            </button>
                            <button
                                onClick={() => setSelectedType('BASIC')}
                                className={`px-4 py-2 rounded-lg font-medium transition-colors cursor-pointer ${selectedType === 'BASIC'
                                    ? 'bg-brand-primary text-text-on-brand'
                                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                                    }`}
                            >
                                {t('filterBasic', { count: stats.basic })}
                            </button>
                            <button
                                onClick={() => setSelectedType('ALLOWANCE')}
                                className={`px-4 py-2 rounded-lg font-medium transition-colors cursor-pointer ${selectedType === 'ALLOWANCE'
                                    ? 'bg-status-success text-white'
                                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                                    }`}
                            >
                                {t('filterAllowances', { count: stats.allowance })}
                            </button>
                            <button
                                onClick={() => setSelectedType('BONUS')}
                                className={`px-4 py-2 rounded-lg font-medium transition-colors cursor-pointer ${selectedType === 'BONUS'
                                    ? 'bg-status-info text-white'
                                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                                    }`}
                            >
                                {t('filterBonus', { count: stats.bonus })}
                            </button>
                        </div>
                    </div>

                    {/* Table */}
                    <div className="bg-surface-card rounded-2xl border border-surface-border overflow-hidden">
                        <div className="overflow-x-auto">
                            <table className="w-full">
                                <thead className="bg-slate-50 border-b border-slate-200">
                                    <tr>
                                        <th className="px-6 py-4 text-start text-sm font-semibold text-text-heading">{t('colTypeNotes')}</th>
                                        <th className="px-6 py-4 text-start text-sm font-semibold text-text-heading">{t('colDescribe')}</th>
                                        <th className="px-6 py-4 text-center text-sm font-semibold text-text-heading">{t('colEffect')}</th>
                                        <th className="px-6 py-4 text-end text-sm font-semibold text-text-heading">{t('colAmount')}</th>
                                        <th className="px-6 py-4 text-center text-sm font-semibold text-text-heading" colSpan={3}>{tc('actions')}</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-200">
                                    {loading ? (
                                        <tr>
                                            <td colSpan={7} className="px-6 py-12 text-center">
                                                <div className="flex items-center justify-center">
                                                    <div className="w-8 h-8 border-4 border-brand-primary border-t-transparent rounded-full animate-spin"></div>
                                                </div>
                                            </td>
                                        </tr>
                                    ) : filteredComponents.length === 0 ? (
                                        <tr>
                                            <td colSpan={7} className="px-6 py-12 text-center">
                                                <CurrencyIcon size={48} className="text-slate-300 mx-auto mb-3" />
                                                <p className="text-slate-400 font-medium">{t('emptyNoComponents')}</p>
                                                <p className="text-sm text-slate-400 mt-1">{t('emptyClickToAdd', { addLabel: t('addComponentBtn') })}</p>
                                            </td>
                                        </tr>
                                    ) : (
                                        Object.values(groupedByEmployee).map((group) => (
                                            <React.Fragment key={group.employee.id}>
                                                {/* Employee Row */}
                                                <tr className="bg-slate-50">
                                                    <td colSpan={7} className="px-6 py-3">
                                                        <div className="flex items-center justify-between">
                                                            <div className="flex items-center gap-3">
                                                                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-brand-primary to-brand-primary-dark flex items-center justify-center text-text-on-brand font-bold">
                                                                    {group.employee.fullName.split(' ').map((n: string) => n[0]).join('').slice(0, 2)}
                                                                </div>
                                                                <div>
                                                                    <p className="font-bold text-text-heading text-lg">{group.employee.fullName}</p>
                                                                    <p className="text-sm text-text-muted">
                                                                        {group.employee.employeeCode} • {group.employee.department?.name || t('noDepartments')}
                                                                    </p>
                                                                </div>
                                                            </div>
                                                            <div className="text-end">
                                                                <p className="text-xs text-text-muted">{tc('total')}</p>
                                                                <p className="text-xl font-bold text-status-success">
                                                                    {formatCurrency(group.components.reduce((sum, c) => sum + Number(c.amount), 0))}
                                                                </p>
                                                            </div>
                                                        </div>
                                                    </td>
                                                </tr>
                                                {/* Component Rows */}
                                                {group.components.map((component, index) => (
                                                    <tr
                                                        key={component.id}
                                                        data-testid="sc-row"
                                                        data-component-id={component.id}
                                                        data-component-type={component.componentType}
                                                        data-amount={Number(component.amount)}
                                                        className={`hover:bg-slate-50 transition-colors ${index === group.components.length - 1 ? 'border-b-2 border-slate-200' : ''}`}>
                                                        <td className="px-6 py-3 ps-20">
                                                            <div className="flex items-center gap-2">
                                                                <div className="w-1 h-8 bg-brand-primary rounded-full"></div>
                                                                <div>
                                                                    {getTypeBadge(component.componentType)}
                                                                </div>
                                                            </div>
                                                        </td>
                                                        <td className="px-6 py-3 text-sm text-text-body">
                                                            {component.note || '-'}
                                                        </td>
                                                        <td className="px-6 py-3 text-center">
                                                            <span className="text-xs text-text-muted">
                                                                {new Date(component.effectiveDate).toLocaleDateString('en-IN', { timeZone: getCompanyTz() })}
                                                            </span>
                                                        </td>
                                                        <td className="px-6 py-3 text-end">
                                                            <span className="font-bold text-status-success">
                                                                {formatCurrency(Number(component.amount))}
                                                            </span>
                                                        </td>
                                                        <td className="px-6 py-3" colSpan={3}>
                                                            <div className="flex items-center justify-end gap-2">
                                                                {can('MANAGE_SALARY_COMPONENTS') && (
                                                                    <>
                                                                        <button
                                                                            data-testid="sc-edit"
                                                                            onClick={() => {
                                                                                setEditingComponent(component);
                                                                                setFormData({
                                                                                    employeeId: component.employeeId,
                                                                                    componentType: component.componentType,
                                                                                    amount: Number(component.amount),
                                                                                    effectiveDate: new Date(component.effectiveDate).toISOString().split('T')[0],
                                                                                    note: component.note || '',
                                                                                });
                                                                                setShowModal(true);
                                                                            }}
                                                                            className="p-2 hover:bg-brand-primary-light/10 rounded-lg text-brand-primary transition-colors cursor-pointer"
                                                                            title={tc('edit')}
                                                                        >
                                                                            <Edit size={16} />
                                                                        </button>
                                                                        {/* DELETE /salary-components/:id is ADMIN-only on the
                                                                            server, and deleting a component erases the row a
                                                                            produced payslip was calculated from. HR retires a
                                                                            component with Deactivate instead. */}
                                                                        {isAdmin() && (
                                                                            <button
                                                                                data-testid="sc-delete"
                                                                                onClick={() => handleDelete(component.id)}
                                                                                className="p-2 hover:bg-status-error-bg/40 rounded-lg text-status-error transition-colors cursor-pointer"
                                                                                title={tc('delete')}
                                                                            >
                                                                                <Trash2 size={16} />
                                                                            </button>
                                                                        )}
                                                                    </>
                                                                )}
                                                            </div>
                                                        </td>
                                                    </tr>
                                                ))}
                                            </React.Fragment>
                                        ))
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    {/* Modal Dialog */}
                    {showModal && (
                        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
                            <motion.div
                                initial={{ opacity: 0, scale: 0.9 }}
                                animate={{ opacity: 1, scale: 1 }}
                                className="bg-surface-card rounded-2xl p-8 max-w-xl w-full max-h-[90vh] overflow-y-auto"
                            >
                                <div className="flex items-center justify-between mb-6">
                                    <h3 className="text-2xl font-bold text-text-heading">
                                        {editingComponent ? t('modalTitleEdit') : t('modalTitleAdd')}
                                    </h3>
                                    <button
                                        onClick={() => setShowModal(false)}
                                        className="p-1 hover:bg-slate-100 rounded-lg transition-colors text-text-muted cursor-pointer"
                                    >
                                        <X size={24} />
                                    </button>
                                </div>

                                <form onSubmit={handleSubmit} className="space-y-4">
                                    <div>
                                        <label className="block text-sm font-medium text-text-body mb-2">
                                            {tc('employee')} <span className="text-status-error">*</span>
                                        </label>
                                        <select
                                            data-testid="sc-employee"
                                            value={formData.employeeId}
                                            onChange={(e) => setFormData({ ...formData, employeeId: e.target.value })}
                                            className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand-primary/20"
                                            disabled={!!editingComponent}
                                            required
                                        >
                                            <option value="">{t('selectEmployeeOption')}</option>
                                            {employees.map((emp) => (
                                                <option key={emp.id} value={emp.id}>
                                                    {emp.employeeCode} - {emp.fullName}
                                                </option>
                                            ))}
                                        </select>
                                    </div>

                                    <div>
                                        <label className="block text-sm font-medium text-text-body mb-2">
                                            {t('typeLabel')} <span className="text-status-error">*</span>
                                        </label>
                                        <select
                                            data-testid="sc-type"
                                            value={formData.componentType}
                                            onChange={(e) => setFormData({ ...formData, componentType: e.target.value as ComponentType })}
                                            className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand-primary/20"
                                            required
                                        >
                                            {modalTypeOptions.map((opt) => (
                                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                                            ))}
                                        </select>
                                    </div>

                                    <div>
                                        <label className="block text-sm font-medium text-text-body mb-2">
                                            {t('amountLabel')} <span className="text-status-error">*</span>
                                        </label>
                                        {/*
                                            Money, so cents. `step="1000"` made the browser REFUSE
                                            any amount that was not a multiple of a thousand — an
                                            HRA of 8500 or a transport allowance of 1250 could not
                                            be saved at all, and the only feedback was a native
                                            tooltip on a submit that never fired.
                                        */}
                                        <input
                                            data-testid="sc-amount"
                                            type="number"
                                            value={formData.amount}
                                            onChange={(e) => setFormData({ ...formData, amount: Number(e.target.value) || 0 })}
                                            min="0"
                                            step="0.01"
                                            className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand-primary/20"
                                            placeholder={t('amountPlaceholder')}
                                            required
                                        />
                                    </div>

                                    <div>
                                        <label className="block text-sm font-medium text-text-body mb-2">
                                            {t('effectiveDateLabel')} <span className="text-status-error">*</span>
                                        </label>
                                        <input
                                            data-testid="sc-effective-date"
                                            type="date"
                                            value={formData.effectiveDate}
                                            onChange={(e) => setFormData({ ...formData, effectiveDate: e.target.value })}
                                            className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand-primary/20"
                                            required
                                        />
                                    </div>

                                    <div>
                                        <label className="block text-sm font-medium text-text-body mb-2">
                                            {t('describeNoteLabel')}
                                        </label>
                                        <textarea
                                            data-testid="sc-note"
                                            value={formData.note}
                                            onChange={(e) => setFormData({ ...formData, note: e.target.value })}
                                            rows={3}
                                            className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand-primary/20"
                                            placeholder={t('notesOptionalPlaceholder')}
                                        />
                                    </div>

                                    <div className="flex gap-4 mt-6">
                                        <button
                                            data-testid="sc-modal-save"
                                            type="submit"
                                            className="flex-1 px-6 py-3 bg-brand-primary text-text-on-brand rounded-xl font-semibold hover:bg-brand-primary-dark transition-colors shadow-lg shadow-brand-primary/20 cursor-pointer"
                                        >
                                            {editingComponent ? t('saveChangesBtn') : t('addComponentBtn')}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setShowModal(false)}
                                            className="px-6 py-3 border border-slate-200 text-text-body rounded-xl hover:bg-slate-50 transition-colors cursor-pointer"
                                        >
                                            {tc('cancel')}
                                        </button>
                                    </div>
                                </form>
                            </motion.div>
                        </div>
                    )}

                    {/* Info */}
                    <div className="bg-brand-primary-light/10 border-s-4 border-brand-primary p-4 rounded-e-lg">
                        <h4 className="text-sm font-semibold text-brand-primary mb-2">{t('infoNoteHeading')}</h4>
                        <ul className="text-sm text-text-body space-y-1 list-disc list-inside">
                            <li><strong>{t('infoBasicSalary')}</strong> {t('infoBasicSalaryDesc')}</li>
                            <li><strong>{t('infoAllowance')}</strong> {t('infoAllowanceDesc')}</li>
                            <li><strong>{t('infoBonus')}</strong> {t('infoBonusDesc')}</li>
                            <li>{t('infoEffectiveDate')}</li>
                        </ul>
                    </div>
                </div>
            </>
        </ProtectedRoute>
    );
}

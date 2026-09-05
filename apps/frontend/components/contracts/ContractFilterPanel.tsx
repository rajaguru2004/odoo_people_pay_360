'use client';

import { X, Filter } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslations } from 'next-intl';

export interface ContractFilterState {
    statuses: string[];
    contractTypes: string[];
    departments: string[];
    expiring: boolean;
}

interface ContractFilterPanelProps {
    isOpen: boolean;
    onClose: () => void;
    filters: ContractFilterState;
    onFilterChange: (filters: ContractFilterState) => void;
    departments: Array<{ id: string; name: string }>;
}

export default function ContractFilterPanel({
    isOpen,
    onClose,
    filters,
    onFilterChange,
    departments,
}: ContractFilterPanelProps) {
    const t = useTranslations('contractFilterPanel');

    const statuses = [
        { value: 'ACTIVE', label: t('statusActive') },
        { value: 'EXPIRED', label: t('statusExpired') },
        { value: 'TERMINATED', label: t('statusTerminated') },
    ];

    const contractTypes = [
        { value: 'PROBATION', label: t('typeProbation') },
        { value: 'FIXED_TERM', label: t('typeFixedTerm') },
        { value: 'INDEFINITE', label: t('typeIndefinite') },
    ];

    const toggleArrayFilter = (key: keyof ContractFilterState, value: string) => {
        const currentValues = filters[key] as string[];
        const newValues = currentValues.includes(value)
            ? currentValues.filter(v => v !== value)
            : [...currentValues, value];
        onFilterChange({ ...filters, [key]: newValues });
    };

    const clearFilters = () => {
        onFilterChange({
            statuses: [],
            contractTypes: [],
            departments: [],
            expiring: false,
        });
    };

    const activeFilterCount =
        filters.statuses.length +
        filters.contractTypes.length +
        filters.departments.length +
        (filters.expiring ? 1 : 0);

    return (
        <AnimatePresence>
            {isOpen && (
                <>
                    {/* Backdrop */}
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={onClose}
                        className="fixed inset-0 bg-black/20 backdrop-blur-sm z-40"
                    />

                    {/* Panel */}
                    <motion.div
                        initial={{ x: 400, opacity: 0 }}
                        animate={{ x: 0, opacity: 1 }}
                        exit={{ x: 400, opacity: 0 }}
                        transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                        className="fixed end-0 top-0 h-full w-96 bg-surface-card shadow-2xl z-50 overflow-y-auto"
                    >
                        {/* Header */}
                        <div className="sticky top-0 bg-surface-card border-b border-surface-border p-6 z-10">
                            <div className="flex items-center justify-between mb-2">
                                <div className="flex items-center gap-3">
                                    <div className="w-10 h-10 rounded-[--radius-button] bg-brand-primary flex items-center justify-center">
                                        <Filter className="text-white" size={20} />
                                    </div>
                                    <div>
                                        <h2 className="text-xl font-bold text-text-heading">{t('title')}</h2>
                                        {activeFilterCount > 0 && (
                                            <p className="text-sm text-text-muted">{t('filtersApplyingCount', { count: activeFilterCount })}</p>
                                        )}
                                    </div>
                                </div>
                                <button
                                    onClick={onClose}
                                    className="p-2 hover:bg-surface-page rounded-[--radius-button] transition-colors"
                                >
                                    <X size={20} className="text-text-muted" />
                                </button>
                            </div>
                            {activeFilterCount > 0 && (
                                <button
                                    onClick={clearFilters}
                                    className="text-sm text-brand-primary hover:text-brand-primary-dark font-medium"
                                >
                                    {t('clearAllFilters')}
                                </button>
                            )}
                        </div>

                        {/* Filters */}
                        <div className="p-6 space-y-6">
                            {/* Status Filter */}
                            <div>
                                <label className="block text-sm font-semibold text-text-body mb-3">
                                    {t('statusSection')}
                                </label>
                                <div className="space-y-2">
                                    {statuses.map((status) => (
                                        <label
                                            key={status.value}
                                            className="flex items-center gap-3 p-3 rounded-[--radius-button] hover:bg-surface-page cursor-pointer transition-colors"
                                        >
                                            <input
                                                type="checkbox"
                                                checked={filters.statuses.includes(status.value)}
                                                onChange={() => toggleArrayFilter('statuses', status.value)}
                                                className="w-4 h-4 text-brand-primary rounded-[--radius-input] focus:ring-2 focus:ring-brand-primary/20"
                                            />
                                            <span className="text-sm font-medium text-text-body">{status.label}</span>
                                        </label>
                                    ))}
                                </div>
                            </div>

                            {/* Contract Type Filter */}
                            <div>
                                <label className="block text-sm font-semibold text-text-body mb-3">
                                    {t('typeSection')}
                                </label>
                                <div className="space-y-2">
                                    {contractTypes.map((type) => (
                                        <label
                                            key={type.value}
                                            className="flex items-center gap-3 p-3 rounded-[--radius-button] hover:bg-surface-page cursor-pointer transition-colors"
                                        >
                                            <input
                                                type="checkbox"
                                                checked={filters.contractTypes.includes(type.value)}
                                                onChange={() => toggleArrayFilter('contractTypes', type.value)}
                                                className="w-4 h-4 text-brand-primary rounded-[--radius-input] focus:ring-2 focus:ring-brand-primary/20"
                                            />
                                            <span className="text-sm font-medium text-text-body">{type.label}</span>
                                        </label>
                                    ))}
                                </div>
                            </div>

                            {/* Department Filter */}
                            <div>
                                <label className="block text-sm font-semibold text-text-body mb-3">
                                    {t('departmentSection')}
                                </label>
                                <div className="space-y-2 max-h-64 overflow-y-auto">
                                    {departments.map((dept) => (
                                        <label
                                            key={dept.id}
                                            className="flex items-center gap-3 p-3 rounded-[--radius-button] hover:bg-surface-page cursor-pointer transition-colors"
                                        >
                                            <input
                                                type="checkbox"
                                                checked={filters.departments.includes(dept.id)}
                                                onChange={() => toggleArrayFilter('departments', dept.id)}
                                                className="w-4 h-4 text-brand-primary rounded-[--radius-input] focus:ring-2 focus:ring-brand-primary/20"
                                            />
                                            <span className="text-sm font-medium text-text-body">{dept.name}</span>
                                        </label>
                                    ))}
                                </div>
                            </div>

                            {/* Expiring Soon */}
                            <div>
                                <label className="flex items-center gap-3 p-4 rounded-[--radius-card] bg-brand-accent/10 border border-brand-accent/20 cursor-pointer hover:bg-brand-accent/20 transition-colors">
                                    <input
                                        type="checkbox"
                                        checked={filters.expiring}
                                        onChange={(e) => onFilterChange({ ...filters, expiring: e.target.checked })}
                                        className="w-4 h-4 text-brand-accent rounded-[--radius-input] focus:ring-2 focus:ring-brand-accent/20"
                                    />
                                    <div>
                                        <span className="text-sm font-semibold text-brand-accent-dark block">{t('expiringSoonLabel')}</span>
                                        <span className="text-xs text-brand-accent-dark/80">{t('expiringSoonHelper')}</span>
                                    </div>
                                </label>
                            </div>
                        </div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
}

'use client';

import { FileSignature, CheckCircle, XCircle, Clock, TrendingUp } from 'lucide-react';
import { motion } from 'framer-motion';
import { useTranslations } from 'next-intl';

interface ContractStatsBarProps {
    total: number;
    active: number;
    expired: number;
    expiringSoon: number;
}

export default function ContractStatsBar({ total, active, expired, expiringSoon }: ContractStatsBarProps) {
    const t = useTranslations('contractStatsBar');
    const stats = [
        {
            label: t('totalContract'),
            value: total,
            icon: FileSignature,
            gradient: 'from-brand-primary/80 to-brand-primary',
            bgColor: 'bg-brand-primary-light/10',
            borderColor: 'border-brand-primary/20',
            textColor: 'text-brand-primary',
        },
        {
            label: t('inEffect'),
            value: active,
            icon: CheckCircle,
            gradient: 'from-status-success/80 to-status-success',
            bgColor: 'bg-status-success-bg/30',
            borderColor: 'border-status-success/20',
            textColor: 'text-status-success',
        },
        {
            label: t('expiringSoon'),
            value: expiringSoon,
            icon: Clock,
            gradient: 'from-brand-accent/80 to-brand-accent',
            bgColor: 'bg-brand-accent/10',
            borderColor: 'border-brand-accent/20',
            textColor: 'text-brand-accent',
        },
        {
            label: t('expired'),
            value: expired,
            icon: XCircle,
            gradient: 'from-status-error/80 to-status-error',
            bgColor: 'bg-status-error-bg/30',
            borderColor: 'border-status-error/20',
            textColor: 'text-status-error',
        },
    ];

    return (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {stats.map((stat, index) => {
                const Icon = stat.icon;
                return (
                    <motion.div
                        key={stat.label}
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: index * 0.1 }}
                        className={`group bg-surface-card rounded-[--radius-card] p-6 border ${stat.borderColor} hover:shadow-lg transition-all cursor-pointer`}
                    >
                        <div className="flex items-start justify-between mb-4">
                            <div className={`w-12 h-12 rounded-[--radius-card] bg-gradient-to-br ${stat.gradient} flex items-center justify-center shadow-lg`}>
                                <Icon className="text-white" size={24} />
                            </div>
                            <div className={`px-2 py-1 rounded-[--radius-button] ${stat.bgColor} border ${stat.borderColor}`}>
                                <TrendingUp className={stat.textColor} size={14} />
                            </div>
                        </div>
                        <p className="text-sm font-semibold text-text-muted mb-1">{stat.label}</p>
                        <p className="text-3xl font-bold text-text-heading">{stat.value}</p>
                    </motion.div>
                );
            })}
        </div>
    );
}

'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { terminationRequestService } from '@/services/terminationRequestService';
import {
    TerminationCategory,
    TERMINATION_CATEGORY_LABELS,
    CreateTerminationRequestDto,
} from '@/types/termination-request';
import { toast } from '@/lib/toast';
import { getApiErrorMessage } from '@/lib/apiError';

interface TerminationRequestFormProps {
    contractId: string;
    userId: string;
    onSuccess?: () => void;
    onCancel?: () => void;
}

export default function TerminationRequestForm({
    contractId,
    userId,
    onSuccess,
    onCancel,
}: TerminationRequestFormProps) {
    const t = useTranslations('terminationRequestForm');
    const tc = useTranslations('common');
    const [loading, setLoading] = useState(false);
    const [formData, setFormData] = useState({
        terminationCategory: '' as TerminationCategory,
        noticeDate: '',
        terminationDate: '',
        reason: '',
    });

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);

        try {
            const data: CreateTerminationRequestDto = {
                contractId,
                requestedBy: userId,
                terminationCategory: formData.terminationCategory,
                noticeDate: formData.noticeDate,
                terminationDate: formData.terminationDate,
                reason: formData.reason,
            };

            await terminationRequestService.createTerminationRequest(data);
            toast.success(t('createSuccess'));
            onSuccess?.();
        } catch (error: any) {
            const errorMessage = getApiErrorMessage(error, t('createFailed'));
            toast.error(errorMessage);
        } finally {
            setLoading(false);
        }
    };

    return (
        <form onSubmit={handleSubmit} className="space-y-6">
            <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                    {t('terminationTypeLabel')} <span className="text-red-500">*</span>
                </label>
                <select
                    data-testid="con-termreq-category"
                    value={formData.terminationCategory}
                    onChange={(e) =>
                        setFormData({ ...formData, terminationCategory: e.target.value as TerminationCategory })
                    }
                    required
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-primary/20 focus:border-transparent"
                >
                    <option value="">{t('selectTerminationType')}</option>
                    {Object.entries(TERMINATION_CATEGORY_LABELS).map(([key, label]) => (
                        <option key={key} value={key}>
                            {label}
                        </option>
                    ))}
                </select>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                        {t('announcementDateLabel')} <span className="text-red-500">*</span>
                    </label>
                    <input
                        type="date"
                        data-testid="con-termreq-notice"
                        value={formData.noticeDate}
                        onChange={(e) => setFormData({ ...formData, noticeDate: e.target.value })}
                        required
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-primary/20 focus:border-transparent"
                    />
                    <p className="text-xs text-gray-500 mt-1">{t('noticeDateHelper')}</p>
                </div>
                <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                        {t('terminationDateLabel')} <span className="text-red-500">*</span>
                    </label>
                    <input
                        type="date"
                        data-testid="con-termreq-date"
                        value={formData.terminationDate}
                        onChange={(e) => setFormData({ ...formData, terminationDate: e.target.value })}
                        required
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-primary/20 focus:border-transparent"
                    />
                    <p className="text-xs text-gray-500 mt-1">{t('terminationDateHelper')}</p>
                </div>
            </div>
            <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                    {t('reasonLabel')} <span className="text-red-500">*</span>
                </label>
                <textarea
                    data-testid="con-termreq-reason"
                    value={formData.reason}
                    onChange={(e) => setFormData({ ...formData, reason: e.target.value })}
                    required
                    rows={4}
                    placeholder={t('reasonPlaceholder')}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-primary/20 focus:border-transparent resize-none"
                />
            </div>

            <div className="bg-brand-primary-light/10 border border-brand-primary-light/30 rounded-lg p-4">
                <h4 className="text-sm font-medium text-blue-900 mb-2">{t('noticeNoteHeading')}</h4>
                <ul className="text-sm text-brand-primary-dark space-y-1">
                    <li>• {t('noticeIndefinite')} <strong>{t('noticeIndefiniteDays')}</strong></li>
                    <li>• {t('notice12to36')} <strong>{t('notice12to36Days')}</strong></li>
                    <li>• {t('noticeUnder12')} <strong>{t('noticeUnder12Days')}</strong></li>
                </ul>
            </div>
            <div className="flex justify-end gap-3">
                {onCancel && (
                    <button
                        type="button"
                        onClick={onCancel}
                        disabled={loading}
                        className="px-6 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                    >
                        {tc('cancel')}
                    </button>
                )}
                <button
                    data-testid="con-termreq-submit"
                    type="submit"
                    disabled={loading}
                    className="px-6 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {loading ? tc('processing') : t('createBtn')}
                </button>
            </div>
        </form>
    );
}

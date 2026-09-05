'use client';

import { Shield } from 'lucide-react';
import { useTranslations } from 'next-intl';

import AutoAbsentTrigger from '@/components/attendance/AutoAbsentTrigger';
import ManualAttendanceEntry from '@/components/attendance/ManualAttendanceEntry';
import { usePageHeader } from '@/hooks/usePageHeader';

export default function AttendanceManagementPage() {
    const t = useTranslations('managementPage');

    // The one heading for this route, rendered by TopHeader.
    usePageHeader(t('title'), t('subtitle'));

    return (
        <>
            <div className="p-6 max-w-7xl mx-auto space-y-6">
                {/* The title/description live in the sticky TopHeader (declared via
                    usePageHeader above). The gradient hero that used to sit here only
                    framed that heading, so it went with it. */}
                {/* Enhanced Admin Notice */}
                <div className="relative overflow-hidden">
                    <div className="absolute inset-0 bg-gradient-to-r from-amber-100 via-orange-100 to-amber-100 rounded-2xl" />
                    <div className="relative bg-white/60 backdrop-blur-sm border-2 border-amber-300 rounded-2xl p-5 shadow-lg">
                        <div className="flex items-start gap-4">
                            <div className="flex-shrink-0">
                                <div className="w-10 h-10 bg-gradient-to-br from-amber-500 to-brand-accent-dark rounded-xl flex items-center justify-center shadow-md">
                                    <Shield className="w-5 h-5 text-white" />
                                </div>
                            </div>
                            <div className="flex-1">
                                <h3 className="text-base font-bold text-amber-900 mb-1 flex items-center gap-2">{t('hrManagerOnly')} <span className="px-2 py-0.5 bg-amber-200 text-amber-800 text-xs font-semibold rounded-full">{t('adminBadge')}</span>
                                </h3>
                                <p data-testid="attman-banner" className="text-sm text-amber-800 leading-relaxed">{t('adminWarning')}</p> </div> </div> </div> </div>                 <AutoAbsentTrigger />

                <ManualAttendanceEntry />


            </div>
        </>
    );
}

'use client';

import React from 'react';
import { useTranslations } from 'next-intl';

interface ProfileCompletionBarProps {
  percentage: number;
  showDetails?: boolean;
}

export default function ProfileCompletionBar({ percentage, showDetails = false }: ProfileCompletionBarProps) {
  const t = useTranslations('employeeProfileLabels');

  const getColor = () => {
    if (percentage >= 80) return 'bg-green-500';
    if (percentage >= 50) return 'bg-yellow-500';
    return 'bg-red-500';
  };

  const getTextColor = () => {
    if (percentage >= 80) return 'text-green-600';
    if (percentage >= 50) return 'text-yellow-600';
    return 'text-red-600';
  };

  const sections = [
    { name: t('personalInfoTab'), value: 20 },
    { name: t('emergencyContactTab'), value: 20 },
    { name: t('educationTab'), value: 20 },
    { name: t('bankTab'), value: 20 },
    { name: t('documentsTab'), value: 20 },
  ];

  return (
    <div className="space-y-3">
      {/* Progress Bar */}
      <div className="relative h-3 bg-gray-200 rounded-full overflow-hidden">
        <div
          className={`h-full ${getColor()} transition-all duration-500 ease-out rounded-full`}
          style={{ width: `${percentage}%` }}
        >
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent animate-shimmer" />
        </div>
      </div>

      {/* Section Breakdown */}
      {showDetails && (
        <div className="grid grid-cols-5 gap-2 mt-4">
          {sections.map((section, index) => {
            const isComplete = percentage >= (index + 1) * 20;
            return (
              <div key={section.name} className="text-center">
                <div className={`w-full h-2 rounded-full mb-1 ${isComplete ? 'bg-green-500' : 'bg-gray-200'}`} />
                <p className="text-xs text-gray-600">{section.name}</p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

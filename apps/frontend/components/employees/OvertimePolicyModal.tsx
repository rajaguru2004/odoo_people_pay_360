'use client';

import React, { useEffect, useState } from 'react';
import { X, Clock, Shield, AlertCircle, CheckCircle2, DollarSign, Calendar, Info, Edit3 } from 'lucide-react';
import overtimePolicyService, { OvertimePolicy, PolicyResolution } from '@/services/overtimePolicyService';
import { useRouter } from 'next/navigation';

interface OvertimePolicyModalProps {
  isOpen: boolean;
  onClose: () => void;
  employeeId: string;
  resolvedPolicy: PolicyResolution | null;
  canEdit?: boolean;
}

export default function OvertimePolicyModal({
  isOpen,
  onClose,
  employeeId,
  resolvedPolicy,
  canEdit = false,
}: OvertimePolicyModalProps) {
  const router = useRouter();
  const [policyDetails, setPolicyDetails] = useState<OvertimePolicy | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isOpen || !resolvedPolicy?.effectivePolicyId) {
      setPolicyDetails(null);
      return;
    }

    let isMounted = true;
    setLoading(true);
    overtimePolicyService
      .get(resolvedPolicy.effectivePolicyId)
      .then((res) => {
        if (isMounted && res?.data) {
          setPolicyDetails(res.data);
        }
      })
      .catch(() => {
        if (isMounted) setPolicyDetails(null);
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen, resolvedPolicy?.effectivePolicyId]);

  if (!isOpen) return null;

  const sourceLabel = (source?: string) => {
    switch (source) {
      case 'EMPLOYEE_OVERRIDE':
        return { text: 'Direct Employee Override', bg: 'bg-purple-100 text-purple-800 border-purple-200' };
      case 'EMPLOYMENT_TYPE':
        return { text: 'Inherited via Employment Type', bg: 'bg-blue-100 text-blue-800 border-blue-200' };
      case 'COMPANY_DEFAULT':
        return { text: 'Company Default Policy', bg: 'bg-emerald-100 text-emerald-800 border-emerald-200' };
      case 'LEGACY_GLOBAL':
      default:
        return { text: 'System Global Settings', bg: 'bg-slate-100 text-slate-800 border-slate-200' };
    }
  };

  const badgeInfo = sourceLabel(resolvedPolicy?.source);
  const rules = policyDetails?.rules || resolvedPolicy?.rules;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-xs p-4 overflow-y-auto">
      <div className="bg-white w-full max-w-2xl rounded-2xl shadow-2xl border border-slate-200 overflow-hidden my-8 animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="bg-linear-to-r from-slate-900 via-indigo-950 to-slate-900 px-6 py-5 text-white flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-purple-500/20 border border-purple-400/30 flex items-center justify-center text-purple-300">
              <Clock size={20} />
            </div>
            <div>
              <h3 className="text-lg font-bold text-white flex items-center gap-2">
                Overtime Policy Details
              </h3>
              <p className="text-xs text-purple-200/80">
                Effective policy rules for {resolvedPolicy?.employeeName || 'employee'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 space-y-6 max-h-[75vh] overflow-y-auto">
          {/* Policy Overview Card */}
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Policy Name</p>
                <h4 className="text-base font-bold text-slate-900 mt-0.5">
                  {resolvedPolicy?.effectivePolicyName || policyDetails?.name || 'Company Default Policy'}
                </h4>
              </div>
              <div className="flex items-center gap-2">
                <span className={`px-2.5 py-1 rounded-full text-xs font-semibold border ${badgeInfo.bg}`}>
                  {badgeInfo.text}
                </span>
                {resolvedPolicy?.eligible !== false ? (
                  <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-green-100 text-green-800 border border-green-200 flex items-center gap-1">
                    <CheckCircle2 size={12} />
                    Eligible for OT
                  </span>
                ) : (
                  <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-800 border border-amber-200 flex items-center gap-1">
                    <AlertCircle size={12} />
                    Exempt / Ineligible
                  </span>
                )}
              </div>
            </div>

            {policyDetails?.description && (
              <p className="text-xs text-slate-600 border-t border-slate-200 pt-2.5 mt-2">
                {policyDetails.description}
              </p>
            )}
          </div>

          {loading ? (
            <div className="py-8 text-center text-slate-500 text-sm">Loading policy rules...</div>
          ) : (
            <>
              {/* Rate Multipliers Grid */}
              <div>
                <h5 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                  <DollarSign size={14} className="text-brand-primary" />
                  Rate Multipliers & Tiers
                </h5>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="p-3.5 bg-purple-50/60 border border-purple-100 rounded-xl">
                    <p className="text-xs text-purple-700 font-medium">Regular Overtime</p>
                    <p className="text-xl font-bold text-purple-950 mt-1">
                      {rules?.regularRate != null ? `${rules.regularRate}x` : '1.5x'}
                    </p>
                    <p className="text-[11px] text-purple-600/80 mt-0.5">Standard weekday OT rate</p>
                  </div>

                  <div className="p-3.5 bg-indigo-50/60 border border-indigo-100 rounded-xl">
                    <p className="text-xs text-indigo-700 font-medium">Late Night Overtime</p>
                    <p className="text-xl font-bold text-indigo-950 mt-1">
                      {rules?.lateRate != null ? `${rules.lateRate}x` : '1.5x'}
                    </p>
                    <p className="text-[11px] text-indigo-600/80 mt-0.5">
                      {rules?.lateThreshold ? `After ${rules.lateThreshold}` : 'After 22:00 threshold'}
                    </p>
                  </div>

                  <div className="p-3.5 bg-emerald-50/60 border border-emerald-100 rounded-xl">
                    <p className="text-xs text-emerald-700 font-medium">Sunday / Rest Day</p>
                    <p className="text-xl font-bold text-emerald-950 mt-1">
                      {rules?.sunday?.regularRate != null
                        ? `${rules.sunday.regularRate}x`
                        : rules?.doubleRate != null
                        ? `${rules.doubleRate}x`
                        : '2.0x'}
                    </p>
                    <p className="text-[11px] text-emerald-600/80 mt-0.5">Rest day multiplier</p>
                  </div>
                </div>
              </div>

              {/* Rules & Limits */}
              <div>
                <h5 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                  <Shield size={14} className="text-brand-primary" />
                  Policy Limits & Rules
                </h5>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl flex items-start gap-3">
                    <Calendar size={18} className="text-slate-500 mt-0.5 shrink-0" />
                    <div>
                      <p className="text-xs font-semibold text-slate-700">Public Holiday OT Rate</p>
                      <p className="text-sm font-bold text-slate-900 mt-0.5">
                        {rules?.holiday?.regularRate != null ? `${rules.holiday.regularRate}x` : '2.0x'}
                      </p>
                      <p className="text-[11px] text-slate-500">
                        Behavior: {rules?.holidayBehavior || resolvedPolicy?.holidayBehavior || 'STANDARD'}
                      </p>
                    </div>
                  </div>

                  <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl flex items-start gap-3">
                    <Clock size={18} className="text-slate-500 mt-0.5 shrink-0" />
                    <div>
                      <p className="text-xs font-semibold text-slate-700">Max Hours Limits</p>
                      <p className="text-sm font-bold text-slate-900 mt-0.5">
                        {rules?.maxHoursPerDay ? `${rules.maxHoursPerDay}h / day` : 'No daily cap'}
                      </p>
                      <p className="text-[11px] text-slate-500">
                        {rules?.maxHoursPerMonth ? `${rules.maxHoursPerMonth}h / month limit` : 'No monthly cap'}
                      </p>
                    </div>
                  </div>

                  {rules?.foodAllowanceEnabled && (
                    <div className="p-3.5 bg-amber-50/60 border border-amber-200/80 rounded-xl flex items-start gap-3 sm:col-span-2">
                      <Info size={18} className="text-amber-600 mt-0.5 shrink-0" />
                      <div>
                        <p className="text-xs font-semibold text-amber-900">Food / Meal Allowance</p>
                        <p className="text-sm font-bold text-amber-950 mt-0.5">
                          ${rules.foodAllowanceAmount || 0} allowance
                        </p>
                        <p className="text-[11px] text-amber-700">
                          Triggered when overtime extends past {rules.foodAllowanceThreshold || '20:00'}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="bg-slate-50 border-t border-slate-200 px-6 py-4 flex items-center justify-between">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-white hover:bg-slate-100 border border-slate-300 rounded-xl text-sm font-semibold text-slate-700 transition-colors"
          >
            Close
          </button>

          {canEdit && (
            <button
              onClick={() => {
                onClose();
                router.push(`/dashboard/employees/${employeeId}/edit`);
              }}
              className="px-4 py-2 bg-brand-primary hover:bg-brand-primary-dark text-white rounded-xl text-sm font-semibold flex items-center gap-1.5 transition-colors shadow-xs"
            >
              <Edit3 size={15} />
              Change Overtime Policy
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

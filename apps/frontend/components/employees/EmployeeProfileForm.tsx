'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { User, AlertCircle, GraduationCap, CreditCard } from 'lucide-react';
import { EmployeeProfile } from '@/types/employee-profile';
import { useProfileTemplate } from '@/hooks/useProfileTemplate';
import { TemplateFormRenderer } from '@/components/dynamic-form/TemplateFormRenderer';
import {
  buildTemplateSchema,
  toEmployeePayload,
  toFormDefaults,
} from '@/components/dynamic-form/buildTemplateSchema';
import { applyServerErrors } from '@/lib/applyServerErrors';
import { TemplateSection } from '@/types/profile-template';

/**
 * The extended-profile editor, now driven by the Employee Profile Template.
 *
 * The `SECTION_FIELDS` map this used to carry — a hand-maintained list of which
 * fields belong to which tab, used to scope the save payload — is gone: the
 * template already knows, and the two could disagree. The tab IDs remain the
 * component's public API so the employee detail page did not have to change,
 * and each maps to a template section key below.
 */

type TabId = 'personal' | 'emergency' | 'education' | 'bank';

/**
 * Tab -> template section. Keys come from the shipped baseline; a customer who
 * renames a section keeps working because we match on `sectionKey`, which is
 * immutable, never on the label they edited.
 */
const TAB_SECTION: Record<TabId, string> = {
  personal: 'personal_extended',
  emergency: 'emergency_contact',
  education: 'education',
  // Bank ACCOUNT fields are deliberately not here — those are managed via Bank
  // Master and the approval-backed change-request flow, not this form. What
  // this tab has always actually saved is the statutory/tax identifiers.
  bank: 'insurance_tax',
};

interface EmployeeProfileFormProps {
  profile: Partial<EmployeeProfile>;
  onSave: (data: Partial<EmployeeProfile>) => Promise<void>;
  disabled?: boolean;
  /** When set, render only this section (no tab switcher) and save only its fields. */
  section?: TabId;
  /** When provided, show a Cancel button (used when embedded in a modal). */
  onCancel?: () => void;
  /** Resolves the right template when branches differ by country. */
  branchId?: string;
}

export default function EmployeeProfileForm({
  profile,
  onSave,
  disabled = false,
  section,
  onCancel,
  branchId,
}: EmployeeProfileFormProps) {
  const tp = useTranslations('employeeProfileLabels');
  const tc = useTranslations('common');

  const [activeTab, setActiveTab] = useState<TabId>(section ?? 'personal');
  const [saving, setSaving] = useState(false);

  const { data: template, isLoading } = useProfileTemplate({ branchId, mode: 'EDIT' });

  const tabs = [
    { id: 'personal' as TabId, label: tp('personalInfoTab'), Icon: User },
    { id: 'emergency' as TabId, label: tp('emergencyContactTab'), Icon: AlertCircle },
    { id: 'education' as TabId, label: tp('educationTab'), Icon: GraduationCap },
    { id: 'bank' as TabId, label: tp('bankTab'), Icon: CreditCard },
  ];

  /** The template sections this form is responsible for right now. */
  const visibleSections = useMemo<TemplateSection[]>(() => {
    if (!template) return [];
    const wanted = section ? [TAB_SECTION[section]] : [TAB_SECTION[activeTab]];
    return template.sections.filter((s) => wanted.includes(s.sectionKey));
  }, [template, section, activeTab]);

  const fields = useMemo(
    () => visibleSections.flatMap((s) => s.fields),
    [visibleSections],
  );

  const form = useForm<any>({
    resolver: zodResolver(buildTemplateSchema(fields) as any) as any,
    defaultValues: { ...profile, customFields: (profile as any)?.customFields ?? {} },
  });

  // The parent refetches after a save, so the form must follow the new values
  // rather than keep showing what was typed before the round-trip.
  useEffect(() => {
    // Same null normalisation as the admin form: the API sends null for
    // every unset column, and React will not accept null as an input value.
    form.reset(toFormDefaults((profile ?? {}) as any, fields));
  }, [profile, form]);

  // Keep the visible section in sync when opened for a specific one.
  useEffect(() => {
    if (section) setActiveTab(section);
  }, [section]);

  const onSubmit = async (values: Record<string, unknown>) => {
    // Only this section's fields are sent, so editing one card cannot blank
    // another — the reason the old SECTION_FIELDS map existed.
    const scoped: Record<string, unknown> = {};
    for (const f of fields) {
      if (f.storage === 'JSONB') continue;
      if (f.fieldKey in values) scoped[f.fieldKey] = values[f.fieldKey];
    }
    scoped.customFields = (values.customFields ?? {}) as Record<string, unknown>;

    try {
      setSaving(true);
      await onSave(toEmployeePayload(scoped, fields) as Partial<EmployeeProfile>);
    } catch (error) {
      // Per-field messages land on their controls; the parent still surfaces a
      // toast for anything that is not field-shaped.
      applyServerErrors(error, form.setError);
      console.error('Save failed:', error);
    } finally {
      setSaving(false);
    }
  };

  if (isLoading || !template) {
    return (
      <div className="animate-pulse space-y-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-12 bg-gray-100 rounded-lg" />
        ))}
      </div>
    );
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
      {/* Tabs — hidden in single-section mode */}
      {!section && (
        <div className="border-b border-gray-200">
          <div className="flex gap-2 overflow-x-auto">
            {tabs.map((tab) => {
              const Icon = tab.Icon;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2 px-4 py-3 border-b-2 font-semibold text-sm whitespace-nowrap transition-all ${
                    activeTab === tab.id
                      ? 'border-brand-primary text-brand-primary'
                      : 'border-transparent text-gray-600 hover:text-gray-900 hover:border-gray-300'
                  }`}
                >
                  <Icon size={18} />
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="surface-panel p-6">
        {/* An empty `visibleSections` (admin hid the section, or the role sees
            none of it) falls through to the renderer's own empty state. */}
        <TemplateFormRenderer
          template={{ ...template, sections: visibleSections }}
          form={form}
          readOnlyFields={disabled ? fields.map((f) => f.fieldKey) : []}
        />
      </div>

      <div className="flex items-center justify-end gap-3">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
          >
            {tc('cancel')}
          </button>
        )}
        <button
          type="submit"
          disabled={disabled || saving}
          className="px-4 py-2 bg-brand-primary text-white rounded-lg hover:bg-brand-primary-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? tc('saving') : tc('save')}
        </button>
      </div>
    </form>
  );
}

'use client';

import { TemplateSection } from '@/types/profile-template';
import { displayFieldValue } from './fieldValue';

/**
 * Read-only sibling of TemplateFormRenderer.
 *
 * Replaces the hand-written value rows on the employee detail page: those
 * listed a fixed set of fields, so a field an admin added never appeared and a
 * field they removed kept showing "Not updated yet" forever.
 *
 * Card markup is copied verbatim from the page it replaces, so the visual
 * result is unchanged.
 */

export interface TemplateReadViewProps {
  sections: TemplateSection[];
  /** The employee row; bound fields are read from it and from `profile`. */
  employee?: Record<string, any> | null;
  profile?: Record<string, any> | null;
  /** Shown when a field has no value. */
  emptyLabel: string;
  /** Section headings are already rendered by the page's own tab strip. */
  showSectionHeadings?: boolean;
  columns?: number;
}

export function TemplateReadView({
  sections,
  employee,
  profile,
  emptyLabel,
  showSectionHeadings = false,
  columns = 2,
}: TemplateReadViewProps) {
  const grid =
    columns === 1 ? 'grid-cols-1' : 'grid-cols-1 md:grid-cols-2';

  const visible = sections.filter((s) => s.fields.some((f) => f.isActive));

  if (visible.length === 0) {
    return <p className="text-sm text-slate-500">{emptyLabel}</p>;
  }

  return (
    <div className="space-y-6">
      {visible.map((section) => (
        <div key={section.sectionKey}>
          {showSectionHeadings && (
            <h3 className="text-sm font-semibold text-slate-700 mb-3">
              {section.label}
            </h3>
          )}
          <div className={`grid ${grid} gap-4`}>
            {section.fields
              .filter((f) => f.isActive)
              .map((field) => {
                const shown = displayFieldValue(field, employee, profile);
                return (
                  <div
                    key={field.fieldKey}
                    className="p-4 bg-slate-50 rounded-xl"
                    style={{
                      gridColumn:
                        field.colSpan > 1 ? `span ${field.colSpan}` : undefined,
                    }}
                  >
                    <p className="text-xs text-slate-500 mb-1">{field.label}</p>
                    <p className="text-sm font-semibold text-slate-900 break-words">
                      {shown ?? emptyLabel}
                    </p>
                  </div>
                );
              })}
          </div>
        </div>
      ))}
    </div>
  );
}

export default TemplateReadView;

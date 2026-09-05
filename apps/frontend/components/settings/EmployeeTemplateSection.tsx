'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  AlertTriangle,
  Eye,
  GripVertical,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from '@/lib/toast';
import profileTemplateService, {
  UpsertFieldData,
} from '@/services/profileTemplateService';
import systemSettingsService from '@/services/systemSettingsService';
import branchService from '@/services/branchService';
import { getApiErrorMessage } from '@/lib/apiError';
import {
  CountryPreset,
  FIELD_TYPES,
  TemplateDetail,
  TemplateField,
  TemplateSummary,
  VALIDATION_TYPES,
} from '@/types/profile-template';
import { TemplateFormRenderer } from '@/components/dynamic-form/TemplateFormRenderer';

/**
 * Employee Profile Template builder.
 *
 * Three panes: sections on the left, that section's fields in the middle, an
 * inspector on the right. Sections and fields are drag-reorderable.
 *
 * Two things the UI must make honest, because the API enforces them and a
 * builder that hides them just produces confusing 400s:
 *
 *   - a LOCKED field cannot be hidden or retyped, and the registry ships the
 *     reason, so the lock icon carries it as a tooltip;
 *   - a SYSTEM-REQUIRED field cannot be made optional, so its Required toggle
 *     is disabled rather than silently reverting.
 *
 * The Preview tab renders the real TemplateFormRenderer, so what an admin sees
 * here cannot drift from what employees get.
 */

const inputCls =
  'w-full h-10 px-3 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/30 transition-all';
const labelCls = 'block text-xs font-semibold text-slate-600 mb-1';

const ROLES = ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'];
const TEMPLATE_FLAG = 'employee_template_enabled';

/**
 * Human names for the field types.
 *
 * The dropdown used to render the raw enum — TEXT, TEXTAREA, DECIMAL,
 * MULTISELECT — which is what the code calls them, not what an admin choosing
 * between them needs. Each carries an example, because the distinctions that
 * matter here (NUMBER vs DECIMAL vs CURRENCY, SELECT vs MULTISELECT) are only
 * obvious once you see what goes in the box.
 */
const FIELD_TYPE_LABELS: Record<string, string> = {
  TEXT: 'Text — one line',
  TEXTAREA: 'Text — paragraph',
  NUMBER: 'Whole number',
  DECIMAL: 'Decimal number',
  CURRENCY: 'Money',
  DATE: 'Date',
  DATETIME: 'Date and time',
  SELECT: 'Dropdown — pick one',
  MULTISELECT: 'Dropdown — pick several',
  BOOLEAN: 'Yes / No',
  EMAIL: 'Email address',
  PHONE: 'Phone number',
  PHONE_COUNTRY: 'Country (for a phone number)',
  FILE: 'File upload',
  LIBRARY_SELECT: 'Dropdown — from a library list',
};

/** Shown under the dropdown once a type is chosen. */
const FIELD_TYPE_HINTS: Record<string, string> = {
  TEXT: 'e.g. Blood Group, Locker Number',
  TEXTAREA: 'e.g. Dietary Requirements, Notes',
  NUMBER: 'Counts. e.g. Notice Period (days)',
  DECIMAL: 'Fractions allowed. e.g. Shift Hours',
  CURRENCY: 'Formatted as money. e.g. Relocation Allowance',
  DATE: 'e.g. Probation End Date',
  DATETIME: 'Date plus a time of day.',
  SELECT: 'You add the choices after creating the field.',
  MULTISELECT: 'Stores several choices. e.g. Certifications',
  BOOLEAN: 'A checkbox. e.g. Owns a Vehicle',
  EMAIL: 'Checked for a valid address.',
  PHONE: 'e.g. Emergency Contact Number',
  PHONE_COUNTRY: 'Picks a country and shows its dial code.',
  FILE: 'Stores a link to the uploaded file.',
  LIBRARY_SELECT: 'Choices come from a list in Settings → Libraries.',
};

// ── Sortable rows ───────────────────────────────────────────────────────────

function SortableRow({
  id,
  children,
  onClick,
  active,
}: {
  id: string;
  children: React.ReactNode;
  onClick?: () => void;
  active?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm cursor-pointer transition-colors ${
        active
          ? 'border-brand-primary bg-brand-primary/5'
          : 'border-slate-200 bg-white hover:border-slate-300'
      } ${isDragging ? 'opacity-60' : ''}`}
      onClick={onClick}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        onClick={(e) => e.stopPropagation()}
        className="text-slate-300 hover:text-slate-500 cursor-grab active:cursor-grabbing"
        aria-label="Drag to reorder"
      >
        <GripVertical size={16} />
      </button>
      {children}
    </div>
  );
}

// ── Main ────────────────────────────────────────────────────────────────────

export default function EmployeeTemplateSection() {
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  /** The single company-wide template, if one has been created. */
  const companyTemplate = templates.find((t) => t.scope === 'COMPANY') ?? null;
  const [presets, setPresets] = useState<CountryPreset[]>([]);
  const [branches, setBranches] = useState<any[]>([]);
  const [detail, setDetail] = useState<TemplateDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);
  const [activeFieldId, setActiveFieldId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [tab, setTab] = useState<'build' | 'preview'>('build');
  const [adopting, setAdopting] = useState(false);
  const [adoptCountry, setAdoptCountry] = useState('');
  const [adoptScope, setAdoptScope] = useState<'COMPANY' | 'BRANCH'>('COMPANY');
  const [adoptBranchId, setAdoptBranchId] = useState('');
  const [addingField, setAddingField] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const load = useCallback(async () => {
    try {
      const [list, presetList] = await Promise.all([
        profileTemplateService.list(),
        profileTemplateService.listPresets(),
      ]);
      setTemplates(list);
      setPresets(presetList);
      if (!selectedId && list.length) {
        setSelectedId(list.find((t) => t.scope === 'COMPANY')?.id ?? list[0].id);
      }
    } catch (e) {
      toast.error(getApiErrorMessage(e, 'Failed to load templates'));
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => {
    load();
    branchService
      .getAll()
      .then((r) => setBranches(r.data || []))
      .catch(() => undefined);
    systemSettingsService
      .getAll()
      .then((r: any) => {
        const row = (r?.data || []).find((s: any) => s.key === TEMPLATE_FLAG);
        setEnabled(row?.value === 'true');
      })
      .catch(() => undefined);
    // load is stable per selectedId; re-running on every change would refetch
    // the whole list each time the admin clicks a different template.
     
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const d = await profileTemplateService.get(id);
      setDetail(d);
      setActiveSectionId((prev) =>
        prev && d.sections.some((s) => s.id === prev) ? prev : (d.sections[0]?.id ?? null),
      );
    } catch (e) {
      toast.error(getApiErrorMessage(e, 'Failed to load template'));
    }
  }, []);

  useEffect(() => {
    if (selectedId) loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  const activeSection = useMemo(
    () => detail?.sections.find((s) => s.id === activeSectionId) ?? null,
    [detail, activeSectionId],
  );
  const activeField = useMemo(
    () => activeSection?.fields.find((f) => f.id === activeFieldId) ?? null,
    [activeSection, activeFieldId],
  );

  /** Run a mutation, refresh, and report failures with the server's own words. */
  const run = async (fn: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    try {
      await fn();
      if (selectedId) await loadDetail(selectedId);
      if (success) toast.success(success);
      return true;
    } catch (e) {
      // The API refuses locked-field edits with an explanation worth showing
      // verbatim — it names the payroll reason the field cannot move.
      toast.error(getApiErrorMessage(e, 'Change rejected'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const toggleFlag = async (next: boolean) => {
    setBusy(true);
    try {
      await systemSettingsService.update({ [TEMPLATE_FLAG]: String(next) });
      setEnabled(next);
      toast.success(
        next
          ? 'Employee forms now render from this template.'
          : 'Employee forms reverted to the built-in fields.',
      );
    } catch (e) {
      toast.error(getApiErrorMessage(e, 'Failed to change the setting'));
    } finally {
      setBusy(false);
    }
  };

  const onSectionDragEnd = async (e: DragEndEvent) => {
    if (!detail || !e.over || e.active.id === e.over.id) return;
    const ids = detail.sections.map((s) => s.id!);
    const next = arrayMove(
      ids,
      ids.indexOf(e.active.id as string),
      ids.indexOf(e.over.id as string),
    );
    // Optimistic: the drop should feel instant, and a failure reloads anyway.
    setDetail({
      ...detail,
      sections: next.map((id) => detail.sections.find((s) => s.id === id)!),
    });
    await run(() => profileTemplateService.reorderSections(detail.id, next));
  };

  const onFieldDragEnd = async (e: DragEndEvent) => {
    if (!detail || !activeSection || !e.over || e.active.id === e.over.id) return;
    const ids = activeSection.fields.map((f) => f.id!);
    const next = arrayMove(
      ids,
      ids.indexOf(e.active.id as string),
      ids.indexOf(e.over.id as string),
    );
    setDetail({
      ...detail,
      sections: detail.sections.map((s) =>
        s.id === activeSection.id
          ? { ...s, fields: next.map((id) => s.fields.find((f) => f.id === id)!) }
          : s,
      ),
    });
    await run(() => profileTemplateService.reorderFields(detail.id, next));
  };

  const adopt = async () => {
    if (adoptScope === 'BRANCH' && !adoptBranchId) {
      toast.error('Pick a branch for a branch override.');
      return;
    }
    setBusy(true);
    try {
      const created = await profileTemplateService.adopt({
        country: adoptCountry || undefined,
        scope: adoptScope,
        branchId: adoptScope === 'BRANCH' ? adoptBranchId : undefined,
      });
      setAdopting(false);
      await load();
      setSelectedId(created.id);
      toast.success('Template created from the country preset.');
    } catch (e) {
      toast.error(getApiErrorMessage(e, 'Could not create the template'));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-slate-500 py-10">
        <Loader2 className="animate-spin" size={18} /> Loading templates…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header + kill switch */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-bold text-slate-900">Employee Fields</h3>
          <p className="text-sm text-slate-500 mt-1 max-w-2xl">
            Controls which fields appear on the employee create and edit screens,
            what they are called, how they are grouped and who can see them.
          </p>
        </div>
        <label className="flex items-center gap-3 text-sm">
          <span className="text-slate-600">
            {enabled ? 'Template is live' : 'Using built-in fields'}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            disabled={busy}
            onClick={() => toggleFlag(!enabled)}
            className={`relative w-11 h-6 rounded-full transition-colors ${
              enabled ? 'bg-brand-primary' : 'bg-slate-300'
            }`}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
                enabled ? 'left-[22px]' : 'left-0.5'
              }`}
            />
          </button>
        </label>
      </div>

      {!enabled && (
        <div className="flex items-start gap-2 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>
            Changes here are saved but not shown to users yet. Build and preview
            the template, then switch it live — switching back reverts the forms
            with no data loss.
          </span>
        </div>
      )}

      {/* Template picker.
          Unlabelled, this row reads as a status badge rather than a control —
          with a single company template there is nothing to switch between, so
          nothing signals that it switches. The heading and the count make it a
          list; the caption states the rule the list obeys, because "why can I
          not add a second company template" is otherwise only answerable by
          hitting the conflict error. */}
      <div className="space-y-2">
        <div className="flex items-baseline justify-between gap-3">
          <h4 className="text-sm font-medium text-slate-700">
            Templates
            <span className="ml-2 font-normal text-slate-400">
              {templates.length === 1 ? '1 template' : `${templates.length} templates`}
            </span>
          </h4>
          <p className="text-xs text-slate-500">
            One company-wide template, plus an optional override per branch.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {templates.map((t) => {
            const isBranch = t.scope === 'BRANCH';
            const active = selectedId === t.id;
            return (
              <button
                key={t.id}
                type="button"
                aria-pressed={active}
                onClick={() => setSelectedId(t.id)}
                title={
                  isBranch
                    ? `Applies to employees in ${t.branch?.name ?? 'this branch'}, instead of the company template.`
                    : 'Applies to every employee whose branch has no override of its own.'
                }
                className={`px-3 py-1.5 rounded-lg text-sm border transition-colors text-left ${
                  active
                    ? 'border-brand-primary bg-brand-primary/5 text-brand-primary'
                    : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                }`}
              >
                {isBranch ? t.branch?.name ?? 'Branch' : 'Whole company'}
                {/* The bare ISO code read as noise next to the scope. */}
                {t.country ? (
                  <span className={active ? 'text-brand-primary/70' : 'text-slate-400'}>
                    {' · '}
                    {t.country} fields
                  </span>
                ) : null}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setAdopting((v) => !v)}
            // Named for what it does, not where the fields come from: the old
            // "From country preset" described the source and left the action
            // ambiguous, which is why this row looked like it could not grow.
            className="px-3 py-1.5 rounded-lg text-sm border border-dashed border-slate-300 text-slate-600 hover:border-brand-primary hover:text-brand-primary flex items-center gap-1"
          >
            <Plus size={14} /> Add a template
          </button>
        </div>

        {templates.length === 1 && (
          <p className="text-xs text-slate-500">
            Every employee currently uses the company template. Add one to give a
            branch a different set of fields.
          </p>
        )}
      </div>

      {adopting && (
        <div className="border border-slate-200 rounded-xl p-4 bg-slate-50 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className={labelCls}>Country preset</label>
              <select
                className={inputCls}
                value={adoptCountry}
                onChange={(e) => setAdoptCountry(e.target.value)}
              >
                <option value="">Baseline (no country extras)</option>
                {presets.map((p) => (
                  <option key={p.country} value={p.country}>
                    {p.name} (+{p.extraFieldCount} fields)
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>Applies to</label>
              <select
                className={inputCls}
                value={adoptScope}
                onChange={(e) => setAdoptScope(e.target.value as 'COMPANY' | 'BRANCH')}
              >
                <option value="COMPANY">Whole company</option>
                <option value="BRANCH">One branch</option>
              </select>
              {/* The company slot is single-occupancy and the server refuses a
                  second one. Saying so here beats letting the admin fill the
                  form and meet a conflict error at the end. */}
              {adoptScope === 'COMPANY' && companyTemplate && (
                <p className="mt-1 text-xs text-amber-700">
                  A company template already exists. Archive it first, or choose
                  “One branch”.
                </p>
              )}
            </div>
            {adoptScope === 'BRANCH' && (
              <div>
                <label className={labelCls}>Branch</label>
                <select
                  className={inputCls}
                  value={adoptBranchId}
                  onChange={(e) => setAdoptBranchId(e.target.value)}
                >
                  <option value="">Select a branch…</option>
                  {branches.map((b: any) => {
                    // A branch already carrying an override cannot take a
                    // second one. Offering it as selectable only to fail on
                    // save is worse than showing it as taken.
                    // branchId, not branch?.id — the relation is optional on
                    // the summary type, the scalar is not.
                    const taken = templates.some(
                      (t) => t.scope === 'BRANCH' && t.branchId === b.id,
                    );
                    return (
                      <option key={b.id} value={b.id} disabled={taken}>
                        {b.name} {b.country ? `(${b.country})` : ''}
                        {taken ? ' — already has one' : ''}
                      </option>
                    );
                  })}
                </select>
              </div>
            )}
          </div>
          <p className="text-xs text-slate-500">
            The preset is <strong>copied</strong>, not linked. Later updates to
            the preset never overwrite what you change here.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={adopt}
              className="px-3 py-1.5 rounded-lg bg-brand-primary text-white text-sm disabled:opacity-50"
            >
              Create
            </button>
            <button
              type="button"
              onClick={() => setAdopting(false)}
              className="px-3 py-1.5 rounded-lg border border-slate-200 text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {detail && (
        <>
          <div className="flex items-center gap-2 border-b border-slate-200">
            {(['build', 'preview'] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setTab(v)}
                className={`px-4 py-2 text-sm font-semibold border-b-2 -mb-px transition-colors ${
                  tab === v
                    ? 'border-brand-primary text-brand-primary'
                    : 'border-transparent text-slate-500 hover:text-slate-700'
                }`}
              >
                {v === 'build' ? 'Build' : (
                  <span className="flex items-center gap-1">
                    <Eye size={14} /> Preview
                  </span>
                )}
              </button>
            ))}
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                run(
                  () => profileTemplateService.reseed(detail.id),
                  'Re-applied the shipped preset. Your customizations were kept.',
                )
              }
              className="ml-auto flex items-center gap-1 px-3 py-1.5 text-sm text-slate-600 hover:text-brand-primary"
              title="Adds any fields we have shipped since, without touching what you have changed"
            >
              <RefreshCw size={14} /> Check for new fields
            </button>
          </div>

          {tab === 'preview' ? (
            <PreviewPane detail={detail} />
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-[240px_1fr_320px] gap-4">
              {/* Sections */}
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Sections
                </p>
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={onSectionDragEnd}
                >
                  <SortableContext
                    items={detail.sections.map((s) => s.id!)}
                    strategy={verticalListSortingStrategy}
                  >
                    <div className="space-y-1.5">
                      {detail.sections.map((s) => (
                        <SortableRow
                          key={s.id}
                          id={s.id!}
                          active={s.id === activeSectionId}
                          onClick={() => {
                            setActiveSectionId(s.id!);
                            setActiveFieldId(null);
                          }}
                        >
                          <span className="flex-1 truncate">{s.label}</span>
                          <span className="text-xs text-slate-400">
                            {s.fields.filter((f) => f.isActive).length}
                          </span>
                          {!s.isActive && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">
                              hidden
                            </span>
                          )}
                        </SortableRow>
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              </div>

              {/* Fields */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                    {activeSection?.label ?? 'Fields'}
                  </p>
                  <button
                    type="button"
                    disabled={!activeSection}
                    onClick={() => setAddingField(true)}
                    className="flex items-center gap-1 text-sm text-brand-primary disabled:opacity-40"
                  >
                    <Plus size={14} /> Add field
                  </button>
                </div>
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={onFieldDragEnd}
                >
                  <SortableContext
                    items={(activeSection?.fields ?? []).map((f) => f.id!)}
                    strategy={verticalListSortingStrategy}
                  >
                    <div className="space-y-1.5">
                      {(activeSection?.fields ?? []).map((f) => (
                        <SortableRow
                          key={f.id}
                          id={f.id!}
                          active={f.id === activeFieldId}
                          onClick={() => setActiveFieldId(f.id!)}
                        >
                          <span
                            className={`flex-1 truncate ${
                              f.isActive ? '' : 'text-slate-400 line-through'
                            }`}
                          >
                            {f.label}
                          </span>
                          {f.required && (
                            <span className="text-status-error text-xs">*</span>
                          )}
                          {f.origin === 'CUSTOM' && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-brand-primary/10 text-brand-primary">
                              custom
                            </span>
                          )}
                          {f.systemDeprecated && (
                            <span
                              className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700"
                              title="No longer shipped by default. Your data is untouched."
                            >
                              legacy
                            </span>
                          )}
                          {f.locked && (
                            <Lock
                              size={13}
                              className="text-slate-400 shrink-0"
                              aria-label="Required by the system"
                            />
                          )}
                        </SortableRow>
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              </div>

              {/* Inspector */}
              <div>
                {addingField && activeSection ? (
                  <AddFieldPanel
                    onCancel={() => setAddingField(false)}
                    onCreate={async (data) => {
                      const ok = await run(
                        () =>
                          profileTemplateService.createField(detail.id, {
                            ...data,
                            sectionId: activeSection.id!,
                          }),
                        'Field added.',
                      );
                      if (ok) setAddingField(false);
                    }}
                    busy={busy}
                  />
                ) : activeField ? (
                  <FieldInspector
                    key={activeField.id}
                    field={activeField}
                    sections={detail.sections}
                    busy={busy}
                    onSave={(data) =>
                      run(
                        () =>
                          profileTemplateService.updateField(
                            detail.id,
                            activeField.id!,
                            data,
                          ),
                        'Saved.',
                      )
                    }
                    onRemove={() =>
                      run(
                        () =>
                          profileTemplateService.removeField(detail.id, activeField.id!),
                        'Field hidden. Stored values were kept.',
                      )
                    }
                  />
                ) : (
                  <p className="text-sm text-slate-400 border border-dashed border-slate-200 rounded-xl p-6 text-center">
                    Select a field to edit it.
                  </p>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Preview ─────────────────────────────────────────────────────────────────

/** Renders the real runtime renderer so preview cannot drift from reality. */
function PreviewPane({ detail }: { detail: TemplateDetail }) {
  const form = useForm<any>({ defaultValues: { customFields: {} } });
  const template = {
    templateId: detail.id,
    source: 'COMPANY' as const,
    scope: detail.scope,
    branchId: detail.branchId,
    country: detail.country,
    name: detail.name,
    enabled: true,
    sections: detail.sections
      .filter((s) => s.isActive)
      .map((s) => ({ ...s, fields: s.fields.filter((f) => f.isActive) })),
    fields: detail.sections.flatMap((s) => s.fields.filter((f) => f.isActive)),
  };
  return (
    <div className="border border-slate-200 rounded-xl p-6 bg-white pointer-events-none opacity-95">
      <TemplateFormRenderer template={template as any} form={form} />
    </div>
  );
}

// ── Add field ───────────────────────────────────────────────────────────────

function AddFieldPanel({
  onCreate,
  onCancel,
  busy,
}: {
  onCreate: (data: UpsertFieldData) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [label, setLabel] = useState('');
  const [fieldKey, setFieldKey] = useState('');
  const [fieldType, setFieldType] = useState('TEXT');
  const [required, setRequired] = useState(false);
  const [touchedKey, setTouchedKey] = useState(false);

  // The key is immutable once values are stored under it, so derive a sensible
  // one from the label until the admin deliberately edits it.
  const derivedKey = useMemo(
    () =>
      label
        .replace(/[^a-zA-Z0-9 ]/g, '')
        .trim()
        .split(/\s+/)
        .map((w, i) =>
          i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
        )
        .join(''),
    [label],
  );
  const key = touchedKey ? fieldKey : derivedKey;

  return (
    <div className="border border-slate-200 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="font-semibold text-sm text-slate-800">New field</p>
        <button type="button" onClick={onCancel} className="text-slate-400 hover:text-slate-600">
          <X size={16} />
        </button>
      </div>
      <div>
        <label className={labelCls}>Label</label>
        <input
          className={inputCls}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          // A placeholder rather than a default value: a real value here would
          // be submitted by anyone who clicked straight past the field.
          placeholder="e.g. Blood Group"
        />
        <p className="mt-1 text-[11px] text-slate-400">
          What the employee sees on the form. Editable later.
        </p>
      </div>
      <div>
        <label className={labelCls}>Field key</label>
        <input
          className={inputCls}
          value={key}
          onChange={(e) => {
            setTouchedKey(true);
            setFieldKey(e.target.value);
          }}
          placeholder="e.g. bloodGroup"
        />
        <p className="mt-1 text-[11px] text-slate-400">
          {label.trim() && !touchedKey ? (
            <>
              Filled in from the label. Edit it if you want a different key —
              once values are stored under it, it cannot be changed.
            </>
          ) : (
            <>Permanent. Values are stored under this key, so it cannot be changed later.</>
          )}
        </p>
      </div>
      <div>
        <label className={labelCls}>Type</label>
        <select
          className={inputCls}
          value={fieldType}
          onChange={(e) => setFieldType(e.target.value)}
        >
          {FIELD_TYPES.filter(
            (t) => !['DEPARTMENT_SELECT', 'BRANCH_SELECT', 'EMPLOYEE_SELECT'].includes(t),
          ).map((t) => (
            // The raw enum name is what a developer calls it. An admin picking
            // between DECIMAL and CURRENCY needs an example, not a keyword.
            <option key={t} value={t}>
              {FIELD_TYPE_LABELS[t] ?? t}
            </option>
          ))}
        </select>
        {FIELD_TYPE_HINTS[fieldType] && (
          <p className="mt-1 text-[11px] text-slate-400">{FIELD_TYPE_HINTS[fieldType]}</p>
        )}
      </div>
      <label className="flex items-start gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={required}
          onChange={(e) => setRequired(e.target.checked)}
        />
        <span>
          Required
          <span className="block text-[11px] text-slate-400">
            An employee cannot be saved without it. Existing employees keep
            whatever they have until someone next edits them.
          </span>
        </span>
      </label>
      <button
        type="button"
        disabled={busy || !label.trim() || !key.trim()}
        onClick={() => onCreate({ label, fieldKey: key, fieldType, required })}
        className="w-full px-3 py-2 rounded-lg bg-brand-primary text-white text-sm disabled:opacity-50"
      >
        Add field
      </button>
    </div>
  );
}

// ── Inspector ───────────────────────────────────────────────────────────────

function FieldInspector({
  field,
  sections,
  onSave,
  onRemove,
  busy,
}: {
  field: TemplateField & { locked?: boolean; systemRequired?: boolean; lockReason?: string | null };
  sections: TemplateDetail['sections'];
  onSave: (data: UpsertFieldData) => void;
  onRemove: () => void;
  busy: boolean;
}) {
  const [draft, setDraft] = useState<UpsertFieldData>({
    label: field.label,
    sectionId: sections.find((s) => s.fields.some((f) => f.id === field.id))?.id ?? undefined,
    required: field.required,
    helpText: field.helpText ?? '',
    placeholder: field.placeholder ?? '',
    validationType: field.validationType as string,
    regex: field.regex ?? '',
    visibleToRoles: field.visibleToRoles ?? [],
    editableByRoles: field.editableByRoles ?? [],
    selfVisible: field.selfVisible,
    selfEditable: field.selfEditable,
    isSensitive: field.isSensitive,
    isActive: field.isActive,
  });

  const set = (patch: Partial<UpsertFieldData>) => setDraft((d) => ({ ...d, ...patch }));

  const toggleRole = (list: string[] | undefined, role: string) => {
    const current = list ?? [];
    return current.includes(role)
      ? current.filter((r) => r !== role)
      : [...current, role];
  };

  return (
    <div className="border border-slate-200 rounded-xl p-4 space-y-3">
      <div>
        <p className="font-semibold text-sm text-slate-800">{field.label}</p>
        <p className="text-[11px] text-slate-400 font-mono">
          {field.fieldKey} · {field.storage === 'COLUMN' ? 'built-in' : 'custom'}
        </p>
      </div>

      {field.locked && (
        <div className="flex items-start gap-2 text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5">
          <Lock size={13} className="mt-0.5 shrink-0" />
          <span>{field.lockReason ?? 'Required by the system.'}</span>
        </div>
      )}

      <div>
        <label className={labelCls}>Label</label>
        <input
          className={inputCls}
          value={draft.label ?? ''}
          onChange={(e) => set({ label: e.target.value })}
        />
      </div>

      <div>
        <label className={labelCls}>Section</label>
        <select
          className={inputCls}
          value={draft.sectionId ?? ''}
          onChange={(e) => set({ sectionId: e.target.value })}
        >
          {sections.map((s) => (
            <option key={s.id} value={s.id!}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {/* Placeholder and help text sit in different places on the form and are
          easy to confuse. The inspector offered only help text, so an admin
          wanting a greyed example INSIDE the box had nowhere to put it and
          typed it into help text instead — where it renders underneath. Both
          are here now, each saying where it shows up. */}
      <div>
        <label className={labelCls}>Placeholder</label>
        <input
          className={inputCls}
          value={draft.placeholder ?? ''}
          onChange={(e) => set({ placeholder: e.target.value })}
          placeholder="e.g. B+"
        />
        <p className="mt-1 text-[11px] text-slate-400">
          Greyed example shown <strong>inside</strong> the box until the
          employee types. Disappears as they do — never submitted.
        </p>
      </div>

      <div>
        <label className={labelCls}>Help text</label>
        <input
          className={inputCls}
          value={draft.helpText ?? ''}
          onChange={(e) => set({ helpText: e.target.value })}
          placeholder="e.g. As shown on your donor card"
        />
        <p className="mt-1 text-[11px] text-slate-400">
          Shown <strong>below</strong> the box and stays visible. Use it for
          instructions rather than for an example.
        </p>
      </div>

      {field.storage === 'JSONB' && (
        <>
          <div>
            <label className={labelCls}>Validation</label>
            <select
              className={inputCls}
              value={draft.validationType ?? 'NONE'}
              onChange={(e) => set({ validationType: e.target.value })}
            >
              {VALIDATION_TYPES.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          {draft.validationType === 'REGEX' && (
            <div>
              <label className={labelCls}>Pattern</label>
              <input
                className={`${inputCls} font-mono`}
                value={draft.regex ?? ''}
                onChange={(e) => set({ regex: e.target.value })}
              />
            </div>
          )}
        </>
      )}

      <label
        className={`flex items-center gap-2 text-sm ${
          field.systemRequired ? 'text-slate-400' : 'text-slate-700'
        }`}
        title={
          field.systemRequired
            ? 'Every employee must have a value for this — the database requires it.'
            : undefined
        }
      >
        <input
          type="checkbox"
          disabled={field.systemRequired}
          checked={Boolean(draft.required)}
          onChange={(e) => set({ required: e.target.checked })}
        />
        Required
      </label>

      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={Boolean(draft.isSensitive)}
          onChange={(e) => set({ isSensitive: e.target.checked })}
        />
        Sensitive (masked in exports and audit)
      </label>

      <div>
        <label className={labelCls}>Visible to</label>
        <div className="flex flex-wrap gap-1.5">
          {ROLES.map((r) => {
            const all = (draft.visibleToRoles ?? []).length === 0;
            const on = all || (draft.visibleToRoles ?? []).includes(r);
            return (
              <button
                key={r}
                type="button"
                onClick={() => set({ visibleToRoles: toggleRole(draft.visibleToRoles, r) })}
                className={`px-2 py-1 rounded text-[11px] border transition-colors ${
                  on
                    ? 'bg-brand-primary/10 border-brand-primary text-brand-primary'
                    : 'bg-white border-slate-200 text-slate-400'
                }`}
              >
                {r}
              </button>
            );
          })}
        </div>
        <p className="mt-1 text-[11px] text-slate-400">
          {(draft.visibleToRoles ?? []).length === 0
            ? 'Everyone can see this field.'
            : 'Only the selected roles can see this field.'}
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={Boolean(draft.selfVisible)}
            onChange={(e) => set({ selfVisible: e.target.checked })}
          />
          Employees can see it on their own profile
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={Boolean(draft.selfEditable)}
            onChange={(e) => set({ selfEditable: e.target.checked })}
          />
          Employees can change it themselves
        </label>
      </div>

      <div className="flex items-center gap-2 pt-2 border-t border-slate-100">
        <button
          type="button"
          disabled={busy}
          onClick={() => onSave(draft)}
          className="flex-1 px-3 py-2 rounded-lg bg-brand-primary text-white text-sm disabled:opacity-50"
        >
          Save
        </button>
        <button
          type="button"
          disabled={busy || field.locked}
          onClick={onRemove}
          title={
            field.locked
              ? field.lockReason ?? 'This field cannot be removed.'
              : 'Hides the field. Stored values are kept.'
          }
          className="px-3 py-2 rounded-lg border border-slate-200 text-slate-500 hover:text-status-error hover:border-status-error disabled:opacity-40 disabled:hover:text-slate-500 disabled:hover:border-slate-200"
        >
          <Trash2 size={16} />
        </button>
      </div>
    </div>
  );
}

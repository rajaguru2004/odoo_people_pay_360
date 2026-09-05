'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, Loader2, Search, Check, Users, FolderKanban, Lock, Globe,
  Building2, Calendar, Tag, Briefcase, ChevronRight, AlertCircle,
  Clock, CheckCircle2, PauseCircle, XCircle, Zap, Flag, Eye,
} from 'lucide-react';
import projectService from '@/services/projectService';
import employeeService from '@/services/employeeService';
import departmentService from '@/services/departmentService';
import teamService from '@/services/teamService';
import { apiErrorMessage } from '@/utils/apiError';
import type { Project, CreateProjectData } from '@/types/project';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** The only colour shape the server accepts, and the only one CSS can use. */
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function initials(name: string) {
  const parts = name.trim().split(' ');
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function avatarColor(name: string): string {
  const colors = ['#6366f1','#8b5cf6','#ec4899','#f66600','#16A34A','#0891B2','#DC2626','#CA8A04'];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % colors.length;
  return colors[h];
}

// ── Section header ────────────────────────────────────────────────────────────

function SectionLabel({ icon: Icon, title, desc }: { icon: any; title: string; desc?: string }) {
  return (
    <div className="flex items-start gap-3 mb-4">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-primary/10">
        <Icon className="h-3.5 w-3.5 text-brand-primary" />
      </div>
      <div>
        <p className="text-sm font-semibold text-text-heading">{title}</p>
        {desc && <p className="text-xs text-text-muted mt-0.5">{desc}</p>}
      </div>
    </div>
  );
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  project?: Project | null;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function NewProjectModal({ open, onClose, onSaved, project }: Props) {
  const isEdit = !!project;

  const t  = useTranslations('projectForm');
  const te = useTranslations('projectEnums');
  const tc = useTranslations('common');

  // ── Constants (built here so option labels can be translated) ────────────────
  const COLORS = [
    { hex: '#00358F', name: te('colorNavy') },
    { hex: '#6366f1', name: te('colorIndigo') },
    { hex: '#8b5cf6', name: te('colorViolet') },
    { hex: '#ec4899', name: te('colorPink') },
    { hex: '#f66600', name: te('colorOrange') },
    { hex: '#CA8A04', name: te('colorAmber') },
    { hex: '#16A34A', name: te('colorGreen') },
    { hex: '#0891B2', name: te('colorCyan') },
    { hex: '#DC2626', name: te('colorRed') },
    { hex: '#64748b', name: te('colorSlate') },
  ];

  const STATUSES = [
    { value: 'PLANNING',  label: te('statusPlanning'),  icon: Clock,        desc: te('statusPlanningDesc'),  color: '#6366f1' },
    { value: 'ACTIVE',    label: te('statusActive'),    icon: Zap,          desc: te('statusActiveDesc'),    color: '#22c55e' },
    { value: 'ON_HOLD',   label: te('statusOnHold'),    icon: PauseCircle,  desc: te('statusOnHoldDesc'),    color: '#f59e0b' },
    { value: 'COMPLETED', label: te('statusCompleted'), icon: CheckCircle2, desc: te('statusCompletedDesc'), color: '#10b981' },
    { value: 'CANCELLED', label: te('statusCancelled'), icon: XCircle,      desc: te('statusCancelledDesc'), color: '#ef4444' },
  ];

  const PRIORITIES = [
    { value: 'LOW',    label: te('priorityLow'),    desc: te('priorityLowDesc'),    color: '#6b7280', dot: 'bg-slate-400' },
    { value: 'MEDIUM', label: te('priorityMedium'), desc: te('priorityMediumDesc'), color: '#3b82f6', dot: 'bg-blue-500'  },
    { value: 'HIGH',   label: te('priorityHigh'),   desc: te('priorityHighDesc'),   color: '#f59e0b', dot: 'bg-amber-500' },
    { value: 'URGENT', label: te('priorityUrgent'), desc: te('priorityUrgentDesc'), color: '#ef4444', dot: 'bg-red-500'   },
  ];

  const VISIBILITIES = [
    { value: 'PRIVATE',  label: te('visibilityPrivate'),  icon: Lock,      desc: te('visibilityPrivateDesc')  },
    { value: 'INTERNAL', label: te('visibilityInternal'), icon: Building2, desc: te('visibilityInternalDesc') },
    { value: 'PUBLIC',   label: te('visibilityPublic'),   icon: Globe,     desc: te('visibilityPublicDesc')   },
  ];

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  /** R49b — set when the colour the server held was not a hex and was replaced. */
  const [colorReplaced, setColorReplaced] = useState(false);
  const [employees, setEmployees] = useState<any[]>([]);
  const [departments, setDepartments] = useState<any[]>([]);
  const [teams, setTeams] = useState<any[]>([]);

  const [memberSearch, setMemberSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [existingMembers, setExistingMembers] = useState<any[]>([]);
  const [memberPickerOpen, setMemberPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);

  const [form, setForm] = useState<CreateProjectData>({
    name: '', description: '', color: COLORS[0].hex,
    status: 'PLANNING', priority: 'MEDIUM', visibility: 'PRIVATE', taskPrefix: '',
  });

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setMemberPickerOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        const [emp, dep, tm] = await Promise.all([
          employeeService.getAll({ limit: 200, status: 'ACTIVE' } as any),
          departmentService.getAll(),
          teamService.getAll(),
        ]) as [any, any, any];
        setEmployees(emp.data || []);
        setDepartments(dep.data || []);
        setTeams(tm.data || []);
        if (isEdit && project?.id) {
          const mRes = await projectService.getMembers(project.id) as any;
          const mems = mRes.data || [];
          setExistingMembers(mems);
          setSelectedIds(mems.map((m: any) => m.employee?.id).filter(Boolean));
        } else {
          setExistingMembers([]);
          setSelectedIds([]);
        }
      } catch { /* non-fatal */ }
    })();
  }, [open]);

  useEffect(() => {
    if (project) {
      /**
       * R49b — the colour arriving from the server is checked before it is
       * re-sent.
       *
       * Nothing invalid can ORIGINATE here: the picker is ten hard-coded
       * hexes and there is no free-text input. But edit mode pre-filled
       * `color` from whatever the server held and posted it back untouched, so
       * a bad value that arrived by some other route (the API directly, an
       * import, a future screen) was re-committed by an edit that had nothing
       * to do with colour — and the swatch row showed nothing selected while it
       * happened.
       *
       * The server validates the hex now (R49, fixed), which turns that silent
       * round trip into a refusal of an unrelated save: rename a project, get
       * "color must be a valid hex" and no idea which field is meant. So the
       * value is normalised on the way IN, and the substitution is stated
       * rather than done behind the user's back.
       */
      const stored = project.color || '';
      const colorIsUsable = HEX_RE.test(stored);
      setColorReplaced(Boolean(stored) && !colorIsUsable);
      setForm({
        name: project.name, description: project.description || '',
        color: colorIsUsable ? stored : COLORS[0].hex,
        status: project.status, priority: project.priority, visibility: project.visibility,
        taskPrefix: project.taskPrefix || '',
        startDate: project.startDate?.slice(0, 10),
        endDate: project.endDate?.slice(0, 10),
        departmentId: project.departmentId,
        teamId: project.teamId,
        ownerId: project.ownerId,
      });
    } else {
      setColorReplaced(false);
      setForm({ name: '', description: '', color: COLORS[0].hex, status: 'PLANNING', priority: 'MEDIUM', visibility: 'PRIVATE', taskPrefix: '' });
      setSelectedIds([]);
    }
  }, [project, open]);

  const set = (k: keyof CreateProjectData, v: any) => setForm((p) => ({ ...p, [k]: v }));
  const toggle = (id: string) => setSelectedIds((p) => p.includes(id) ? p.filter((x) => x !== id) : [...p, id]);

  /**
   * R48b — the range is checked before the request leaves.
   *
   * The two date inputs used to carry no `min`/`max` from each other, so the
   * browser's own picker offered an impossible range, and `submit()` looked
   * only at the name. Nothing anywhere refused an inverted range: the API
   * stored it verbatim (R48), `ProjectGantt` drew a bar of negative width and
   * the charts endpoint divided by a negative span.
   *
   * The server enforces the order now, on create AND on patch, so an inverted
   * range is a 400 rather than a corrupt row. That makes this check about
   * *where the user is told*: at the field they got wrong, before they commit,
   * rather than as a rejected save after it. `min`/`max` stop the picker
   * offering the range at all; this stops a typed or pasted one.
   */
  const rangeInverted = Boolean(
    form.startDate && form.endDate && form.endDate < form.startDate,
  );

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) { setError(t('errorNameRequired')); return; }
    if (rangeInverted) { setError(t('errorEndBeforeStart')); return; }
    setSaving(true); setError('');
    try {
      const payload = {
        ...form,
        startDate: form.startDate || undefined,
        endDate: form.endDate || undefined,
        departmentId: form.departmentId || undefined,
        teamId: form.teamId || undefined,
        ownerId: form.ownerId || undefined,
        taskPrefix: form.taskPrefix || undefined,
      };
      let projectId = project?.id;
      if (isEdit && project) {
        await projectService.update(project.id, payload);
      } else {
        const res = await projectService.create(payload) as any;
        projectId = res.data?.id || res.id;
      }
      if (projectId) {
        if (isEdit) {
          const existingEmpIds = existingMembers.map((m: any) => m.employee?.id);
          const toAdd = selectedIds.filter((id) => !existingEmpIds.includes(id));
          if (toAdd.length) await projectService.addMember(projectId, toAdd, 'MEMBER');
          const toRemove = existingMembers.filter((m: any) => !selectedIds.includes(m.employee?.id) && m.role !== 'OWNER');
          await Promise.all(toRemove.map((m: any) => projectService.removeMember(projectId!, m.id)));
        } else if (selectedIds.length) {
          await projectService.addMember(projectId, selectedIds, 'MEMBER');
        }
      }
      onSaved(); onClose();
    } catch (err: any) {
      // `lib/axios` rejects with a FLAT object, so `err.response.data.message`
      // is `undefined` and every server refusal — the date-order and hex rules
      // among them — used to surface as the generic fallback (R73).
      setError(apiErrorMessage(err, t('errorSaveFailed')));
    } finally { setSaving(false); }
  };

  const selectedEmployees = employees.filter((e) => selectedIds.includes(e.id));
  const filteredEmployees = employees.filter((e) =>
    (e.fullName || '').toLowerCase().includes(memberSearch.toLowerCase()) ||
    (e.employeeCode || '').toLowerCase().includes(memberSearch.toLowerCase()),
  );

  const projInitials = form.name.trim() ? initials(form.name) : 'PR';

  const inp = 'w-full rounded-xl border border-surface-border bg-surface-page px-3.5 py-2.5 text-sm text-text-body placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-brand-primary/30 transition';

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)' }}
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.97, opacity: 0, y: 12 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.97, opacity: 0, y: 12 }}
            transition={{ type: 'spring', stiffness: 300, damping: 28 }}
            className="flex w-full max-w-5xl overflow-hidden rounded-2xl shadow-2xl"
            style={{ maxHeight: '92vh' }}
            data-testid="project-modal"
            onClick={(e) => e.stopPropagation()}
          >
            {/* ═══ LEFT PANEL — live preview ═══════════════════════════════ */}
            <div
              className="hidden md:flex w-72 shrink-0 flex-col justify-between p-8 transition-all duration-300"
              style={{ background: `linear-gradient(150deg, ${form.color} 0%, ${form.color}bb 100%)` }}
            >
              {/* Project card preview */}
              <div>
                {/* Avatar — white circle so it pops against the color bg */}
                <div
                  className="h-16 w-16 rounded-2xl flex items-center justify-center text-xl font-bold shadow-lg mb-5 transition-all duration-300"
                  style={{ backgroundColor: 'rgba(255,255,255,0.22)', color: '#fff' }}
                >
                  {projInitials}
                </div>

                <h3 className="text-lg font-bold text-white leading-tight mb-1 min-h-[28px]">
                  {form.name || <span className="opacity-30">{t('projectNameLabel')}</span>}
                </h3>
                {form.description && (
                  <p className="text-sm text-white/50 leading-relaxed line-clamp-3 mb-4">{form.description}</p>
                )}

                {/* Badges */}
                <div className="mt-4 flex flex-wrap gap-1.5">
                  {(() => {
                    const s = STATUSES.find((x) => x.value === form.status);
                    return s ? (
                      <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
                        style={{ backgroundColor: `${s.color}30`, color: s.color }}>
                        <s.icon className="h-3 w-3" />{s.label}
                      </span>
                    ) : null;
                  })()}
                  {(() => {
                    const p = PRIORITIES.find((x) => x.value === form.priority);
                    return p ? (
                      <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
                        style={{ backgroundColor: `${p.color}30`, color: p.color }}>
                        <Flag className="h-3 w-3" />{p.label}
                      </span>
                    ) : null;
                  })()}
                  {(() => {
                    const v = VISIBILITIES.find((x) => x.value === form.visibility);
                    return v ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-0.5 text-[11px] font-semibold text-white/70">
                        <v.icon className="h-3 w-3" />{v.label}
                      </span>
                    ) : null;
                  })()}
                </div>

                {/* Date range */}
                {(form.startDate || form.endDate) && (
                  <div className="mt-4 flex items-center gap-1.5 text-xs text-white/50">
                    <Calendar className="h-3.5 w-3.5" />
                    {form.startDate && form.endDate
                      ? t('dateRangeArrowPreview', {
                          start: new Date(form.startDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
                          end: new Date(form.endDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
                        })
                      : form.startDate
                        ? new Date(form.startDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
                        : new Date(form.endDate!).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                  </div>
                )}

                {/* Member bubbles preview */}
                {selectedEmployees.length > 0 && (
                  <div className="mt-5">
                    <p className="text-[10px] font-semibold text-white/30 uppercase tracking-wider mb-2">{tc('team')}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {selectedEmployees.slice(0, 8).map((emp) => (
                        <div
                          key={emp.id}
                          title={emp.fullName}
                          className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-white/10 text-[11px] font-bold text-white shadow-md"
                          style={{ backgroundColor: avatarColor(emp.fullName || '') }}
                        >
                          {initials(emp.fullName || '?')}
                        </div>
                      ))}
                      {selectedEmployees.length > 8 && (
                        <div className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-white/10 bg-white/10 text-[10px] font-bold text-white">
                          {t('overflowCount', { count: selectedEmployees.length - 8 })}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Bottom hint */}
              <p className="text-[10px] text-white/25 leading-relaxed">
                {t('livePreviewArrowNote')}
              </p>
            </div>

            {/* ═══ RIGHT PANEL — form ══════════════════════════════════════ */}
            <div ref={rightRef} className="flex flex-1 flex-col overflow-hidden bg-surface-card">
              {/* Header */}
              <div className="flex items-center justify-between border-b border-surface-border px-6 py-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-primary/10">
                    <FolderKanban className="h-4 w-4 text-brand-primary" />
                  </div>
                  <div>
                    <h2 className="text-base font-semibold text-text-heading">
                      {isEdit ? t('editProjectTitle') : t('newProjectTitle')}
                    </h2>
                    <p className="text-xs text-text-muted">
                      {isEdit ? t('editSubtitleModal') : t('newSubtitleModal')}
                    </p>
                  </div>
                </div>
                <button onClick={onClose} data-testid="project-modal-close" className="rounded-lg p-1.5 text-text-muted hover:bg-surface-page hover:text-text-body transition">
                  <X className="h-4 w-4" />
                </button>
              </div>

              {/* Scrollable form */}
              <form onSubmit={submit} data-testid="project-form" className="flex-1 overflow-y-auto">
                <div className="space-y-8 px-6 py-6">
                  {error && (
                    <div data-testid="project-form-error" className="flex items-center gap-2 rounded-xl border border-status-error/30 bg-status-error-bg px-4 py-3 text-sm text-status-error">
                      <AlertCircle className="h-4 w-4 shrink-0" />{error}
                    </div>
                  )}

                  {/* ── 1. Identity ── */}
                  <section>
                    <SectionLabel icon={Tag} title={t('identityHeading')} desc={t('identityDesc')} />
                    <div className="space-y-4">
                      <div className="grid grid-cols-3 gap-3">
                        <div className="col-span-2">
                          <label className="mb-1.5 block text-xs font-medium text-text-muted">
                            {t('projectNameLabel')} <span className="text-status-error">*</span>
                          </label>
                          <input
                            value={form.name}
                            data-testid="project-form-name"
                            onChange={(e) => set('name', e.target.value)}
                            placeholder={t('projectNamePlaceholder')}
                            className={inp}
                          />
                        </div>
                        <div>
                          <label className="mb-1.5 block text-xs font-medium text-text-muted">
                            {t('taskPrefixLabel')}
                            <span className="ms-1 text-[10px] normal-case text-text-muted/60">{t('taskPrefixPlaceholder')}</span>
                          </label>
                          <input
                            value={form.taskPrefix}
                            maxLength={8}
                            data-testid="project-form-task-prefix"
                            onChange={(e) => set('taskPrefix', e.target.value.toUpperCase())}
                            placeholder={t('taskPrefixPlaceholder')}
                            className={`${inp} uppercase font-mono tracking-wider`}
                          />
                        </div>
                      </div>
                      <div>
                        <label className="mb-1.5 block text-xs font-medium text-text-muted">{tc('description')}</label>
                        <textarea
                          rows={3}
                          data-testid="project-form-description"
                          value={form.description}
                          onChange={(e) => set('description', e.target.value)}
                          placeholder={t('descriptionPlaceholder')}
                          className={`${inp} resize-none`}
                        />
                      </div>

                      {/* Color picker */}
                      <div>
                        <label className="mb-2 block text-xs font-medium text-text-muted">{t('projectColorLabel')}</label>
                        <div data-testid="project-form-color" className="flex flex-wrap gap-2">
                          {COLORS.map(({ hex, name }) => (
                            <button
                              type="button"
                              key={hex}
                              onClick={() => set('color', hex)}
                              data-testid={`project-form-color-${hex.replace('#', '')}`}
                              title={name}
                              className={`group relative h-8 w-8 rounded-full transition-all duration-150 ${
                                form.color === hex
                                  ? 'ring-2 ring-offset-2 ring-offset-surface-card scale-110'
                                  : 'hover:scale-105 opacity-70 hover:opacity-100'
                              }`}
                              style={{ backgroundColor: hex, ['--tw-ring-color' as string]: hex }}
                            >
                              {form.color === hex && (
                                <Check className="absolute inset-0 m-auto h-4 w-4 text-white drop-shadow" />
                              )}
                            </button>
                          ))}
                        </div>
                        {colorReplaced && (
                          <p data-testid="project-form-color-normalised" className="mt-2 flex items-start gap-1.5 text-xs text-text-muted">
                            <AlertCircle className="h-3.5 w-3.5 shrink-0" />{t('colorNormalisedNote')}
                          </p>
                        )}
                      </div>
                    </div>
                  </section>

                  {/* ── 2. Status ── */}
                  <section>
                    <SectionLabel icon={Clock} title={tc('status')} desc={t('statusDesc')} />
                    <div data-testid="project-form-status" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                      {STATUSES.map(({ value, label, icon: Icon, desc, color }) => {
                        const sel = form.status === value;
                        return (
                          <button
                            type="button"
                            key={value}
                            onClick={() => set('status', value)}
                            data-testid={`project-form-status-${value}`}
                            className={`relative flex flex-col items-start gap-1.5 rounded-xl border p-3 text-start transition-all ${
                              sel
                                ? 'border-2 shadow-sm'
                                : 'border-surface-border hover:border-surface-border-dark hover:bg-surface-page'
                            }`}
                            style={sel ? { borderColor: color, backgroundColor: `${color}10` } : {}}
                          >
                            <Icon className="h-4 w-4" style={{ color }} />
                            <span className="text-xs font-semibold text-text-heading">{label}</span>
                            <span className="text-[10px] leading-tight text-text-muted">{desc}</span>
                            {sel && (
                              <span className="absolute end-2 top-2 flex h-4 w-4 items-center justify-center rounded-full"
                                style={{ backgroundColor: color }}>
                                <Check className="h-2.5 w-2.5 text-white" />
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </section>

                  {/* ── 3. Priority & Visibility ── */}
                  <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
                    {/* Priority */}
                    <section>
                      <SectionLabel icon={Flag} title={t('priorityHeading')} desc={t('priorityDesc')} />
                      <div data-testid="project-form-priority" className="space-y-2">
                        {PRIORITIES.map(({ value, label, desc, color, dot }) => {
                          const sel = form.priority === value;
                          return (
                            <button
                              type="button"
                              key={value}
                              onClick={() => set('priority', value)}
                              data-testid={`project-form-priority-${value}`}
                              className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-start transition-all ${
                                sel
                                  ? 'border-2 shadow-sm'
                                  : 'border-surface-border hover:bg-surface-page'
                              }`}
                              style={sel ? { borderColor: color, backgroundColor: `${color}08` } : {}}
                            >
                              <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${dot}`} />
                              <span className="flex-1">
                                <span className="block text-sm font-medium text-text-heading">{label}</span>
                                <span className="text-[10px] text-text-muted">{desc}</span>
                              </span>
                              {sel && <Check className="h-4 w-4 shrink-0" style={{ color }} />}
                            </button>
                          );
                        })}
                      </div>
                    </section>

                    {/* Visibility */}
                    <section>
                      <SectionLabel icon={Eye} title={t('visibilityHeading')} desc={t('visibilityDesc')} />
                      <div data-testid="project-form-visibility" className="space-y-2">
                        {VISIBILITIES.map(({ value, label, icon: Icon, desc }) => {
                          const sel = form.visibility === value;
                          return (
                            <button
                              type="button"
                              key={value}
                              onClick={() => set('visibility', value)}
                              data-testid={`project-form-visibility-${value}`}
                              className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-start transition-all ${
                                sel
                                  ? 'border-2 border-brand-primary bg-brand-primary/5 shadow-sm'
                                  : 'border-surface-border hover:bg-surface-page'
                              }`}
                            >
                              <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${sel ? 'bg-brand-primary text-white' : 'bg-surface-page text-text-muted'}`}>
                                <Icon className="h-3.5 w-3.5" />
                              </div>
                              <span className="flex-1">
                                <span className="block text-sm font-medium text-text-heading">{label}</span>
                                <span className="text-[10px] text-text-muted">{desc}</span>
                              </span>
                              {sel && <Check className="h-4 w-4 shrink-0 text-brand-primary" />}
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  </div>

                  {/* ── 4. Timeline ── */}
                  <section>
                    <SectionLabel icon={Calendar} title={t('timelineHeading')} desc={t('timelineDesc')} />
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="mb-1.5 block text-xs font-medium text-text-muted">{tc('startDate')}</label>
                        <input
                          type="date"
                          value={form.startDate || ''}
                          max={form.endDate || undefined}
                          onChange={(e) => set('startDate', e.target.value)}
                          data-testid="project-form-start-date"
                          className={inp}
                        />
                      </div>
                      <div>
                        <label className="mb-1.5 block text-xs font-medium text-text-muted">{tc('endDate')}</label>
                        <input
                          type="date"
                          value={form.endDate || ''}
                          min={form.startDate || undefined}
                          onChange={(e) => set('endDate', e.target.value)}
                          data-testid="project-form-end-date"
                          className={inp}
                        />
                      </div>
                    </div>
                    {rangeInverted && (
                      <p data-testid="project-form-date-error" className="mt-2 flex items-center gap-1.5 text-xs text-status-error">
                        <AlertCircle className="h-3.5 w-3.5 shrink-0" />{t('errorEndBeforeStart')}
                      </p>
                    )}
                  </section>

                  {/* ── 5. Organization ── */}
                  <section>
                    <SectionLabel icon={Briefcase} title={t('organizationHeading')} desc={t('organizationDesc')} />
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                      <div>
                        <label className="mb-1.5 block text-xs font-medium text-text-muted">{t('ownerLabel')}</label>
                        <select value={form.ownerId || ''} onChange={(e) => set('ownerId', e.target.value)} data-testid="project-form-owner" className={inp}>
                          <option value="">{t('noneOption')}</option>
                          {employees.map((e) => <option key={e.id} value={e.id}>{e.fullName}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="mb-1.5 block text-xs font-medium text-text-muted">{tc('department')}</label>
                        <select value={form.departmentId || ''} onChange={(e) => set('departmentId', e.target.value)} data-testid="project-form-department" className={inp}>
                          <option value="">{t('noneOption')}</option>
                          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="mb-1.5 block text-xs font-medium text-text-muted">{tc('team')}</label>
                        <select value={form.teamId || ''} onChange={(e) => set('teamId', e.target.value)} data-testid="project-form-team" className={inp}>
                          <option value="">{t('noneOption')}</option>
                          {teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
                        </select>
                      </div>
                    </div>
                  </section>

                  {/* ── 6. Team Members ── */}
                  <section>
                    <SectionLabel
                      icon={Users}
                      title={t('teamMembersHeading')}
                      desc={t('teamMembersDesc')}
                    />

                    {/* Selected bubbles */}
                    {selectedEmployees.length > 0 && (
                      <div className="mb-4 flex flex-wrap gap-2">
                        {selectedEmployees.map((emp) => (
                          <div
                            key={emp.id}
                            data-testid={`project-form-member-chip-${emp.id}`}
                            className="group flex items-center gap-2 rounded-full border border-surface-border bg-surface-page px-3 py-1.5 transition hover:border-status-error/40 hover:bg-status-error-bg/30"
                          >
                            <div
                              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
                              style={{ backgroundColor: avatarColor(emp.fullName || '') }}
                            >
                              {initials(emp.fullName || '?')}
                            </div>
                            <span className="max-w-[100px] truncate text-xs font-medium text-text-body">{emp.fullName}</span>
                            <button
                              type="button"
                              onClick={() => toggle(emp.id)}
                              data-testid={`project-form-member-chip-remove-${emp.id}`}
                              className="text-text-muted opacity-0 transition group-hover:opacity-100 hover:text-status-error"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Picker */}
                    <div ref={pickerRef} className="relative">
                      <button
                        type="button"
                        onClick={() => setMemberPickerOpen((v) => !v)}
                        data-testid="project-form-members"
                        className={`flex w-full items-center gap-2 rounded-xl border px-4 py-2.5 text-sm transition ${
                          memberPickerOpen
                            ? 'border-brand-primary ring-2 ring-brand-primary/20 bg-surface-page'
                            : 'border-surface-border bg-surface-page hover:border-brand-primary/50'
                        }`}
                      >
                        <Search className="h-4 w-4 text-text-muted shrink-0" />
                        <span className="flex-1 text-start text-text-muted">
                          {selectedIds.length > 0
                            ? t('membersSelectedSuffix', { count: selectedIds.length })
                            : t('searchAddMembersPlaceholder')}
                        </span>
                        <ChevronRight className={`h-4 w-4 text-text-muted transition-transform ${memberPickerOpen ? 'rotate-90' : ''}`} />
                      </button>

                      <AnimatePresence>
                        {memberPickerOpen && (
                          <motion.div
                            initial={{ opacity: 0, y: -6, scale: 0.98 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: -6, scale: 0.98 }}
                            data-testid="project-form-member-picker"
                            className="absolute start-0 end-0 top-full z-50 mt-1 overflow-hidden rounded-xl border border-surface-border bg-surface-card shadow-xl"
                          >
                            {/* Search */}
                            <div className="flex items-center gap-2 border-b border-surface-border px-3 py-2.5">
                              <Search className="h-4 w-4 shrink-0 text-text-muted" />
                              <input
                                autoFocus
                                value={memberSearch}
                                data-testid="project-form-member-search"
                                onChange={(e) => setMemberSearch(e.target.value)}
                                placeholder={t('searchByNameCodePlaceholder')}
                                className="flex-1 bg-transparent text-sm text-text-body placeholder:text-text-muted focus:outline-none"
                              />
                              {memberSearch && (
                                <button type="button" onClick={() => setMemberSearch('')} className="text-text-muted hover:text-text-body">
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </div>

                            {/* Select all / Clear */}
                            <div className="flex items-center justify-between border-b border-surface-border bg-surface-page px-3 py-1.5">
                              <span className="text-xs text-text-muted">{t('employeesCountLabel', { count: filteredEmployees.length })}</span>
                              <div className="flex gap-3">
                                <button type="button" onClick={() => setSelectedIds(filteredEmployees.map((e) => e.id))}
                                  className="text-xs font-medium text-brand-primary hover:underline">
                                  {t('selectAllBtn')}
                                </button>
                                <button type="button" onClick={() => setSelectedIds([])}
                                  className="text-xs text-text-muted hover:text-text-body hover:underline">
                                  {tc('clear')}
                                </button>
                              </div>
                            </div>

                            {/* Employee list */}
                            <ul className="max-h-48 overflow-y-auto py-1">
                              {filteredEmployees.map((emp) => {
                                const sel = selectedIds.includes(emp.id);
                                return (
                                  <li key={emp.id}>
                                    <button
                                      type="button"
                                      onClick={() => toggle(emp.id)}
                                      data-testid={`project-form-member-option-${emp.id}`}
                                      className={`flex w-full items-center gap-3 px-3 py-2.5 text-sm transition hover:bg-surface-page ${sel ? 'bg-brand-primary/5' : ''}`}
                                    >
                                      <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition ${sel ? 'border-brand-primary bg-brand-primary' : 'border-surface-border'}`}>
                                        {sel && <Check className="h-2.5 w-2.5 text-white" />}
                                      </span>
                                      <div
                                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
                                        style={{ backgroundColor: avatarColor(emp.fullName || '') }}
                                      >
                                        {initials(emp.fullName || '?')}
                                      </div>
                                      <span className="flex-1 text-start">
                                        <span className="block font-medium text-text-body">{emp.fullName}</span>
                                        {emp.employeeCode && (
                                          <span className="text-[10px] text-text-muted">#{emp.employeeCode}</span>
                                        )}
                                      </span>
                                      {emp.department?.name && (
                                        <span className="shrink-0 rounded-full bg-surface-page px-2 py-0.5 text-[10px] text-text-muted border border-surface-border">
                                          {emp.department.name}
                                        </span>
                                      )}
                                    </button>
                                  </li>
                                );
                              })}
                              {filteredEmployees.length === 0 && (
                                <li data-testid="project-form-member-empty" className="py-6 text-center text-xs text-text-muted">{t('noEmployeesFoundEmpty')}</li>
                              )}
                            </ul>

                            <div className="flex items-center justify-between border-t border-surface-border bg-surface-page px-3 py-2">
                              <span className="text-xs text-text-muted">{t('selectedCountLabel', { count: selectedIds.length })}</span>
                              <button type="button" onClick={() => setMemberPickerOpen(false)}
                                data-testid="project-form-member-done"
                                className="rounded-lg bg-brand-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-primary-dark">
                                {t('doneBtn')}
                              </button>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  </section>
                </div>

                {/* Footer */}
                <div className="sticky bottom-0 flex items-center justify-between border-t border-surface-border bg-surface-card/95 backdrop-blur-sm px-6 py-4">
                  <p className="text-xs text-text-muted">
                    {isEdit ? t('footerEditNote') : t('footerCreateNote')}
                  </p>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={onClose}
                      data-testid="project-form-cancel"
                      className="rounded-xl border border-surface-border px-5 py-2 text-sm font-medium text-text-body hover:bg-surface-page transition"
                    >
                      {tc('cancel')}
                    </button>
                    <button
                      type="submit"
                      // Deliberately NOT disabled on an inverted range: R23 is the
                      // finding that a greyed button with no explanation tells the
                      // user nothing. Submitting answers, at the top of the form
                      // and at the field.
                      disabled={saving || !form.name.trim()}
                      data-testid="project-form-submit"
                      className="flex items-center gap-2 rounded-xl bg-brand-primary px-6 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-primary-dark disabled:opacity-50 disabled:cursor-not-allowed transition"
                    >
                      {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                      {isEdit ? t('saveChangesBtn') : t('createProjectBtn')}
                    </button>
                  </div>
                </div>
              </form>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

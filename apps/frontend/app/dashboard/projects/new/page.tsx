'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Loader2, Search, Check, Lock, Globe,
  Building2, ChevronDown, AlertCircle,
  Clock, CheckCircle2, PauseCircle, XCircle, Zap, Flag, X,
  Calendar, Users, Tag,
} from 'lucide-react';
import { ArrowLeftIcon } from '@/components/common/icons/directional';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import projectService from '@/services/projectService';
import employeeService from '@/services/employeeService';
import departmentService from '@/services/departmentService';
import teamService from '@/services/teamService';
import type { CreateProjectData } from '@/types/project';

// ── Helpers ───────────────────────────────────────────────────────────────────

function initials(name: string) {
  const parts = name.trim().split(' ');
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function avatarColor(name: string): string {
  const p = ['#6366f1','#8b5cf6','#ec4899','#f66600','#16A34A','#0891B2','#DC2626','#CA8A04'];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % p.length;
  return p[h];
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function NewProjectPage() {
  const router = useRouter();
  const t  = useTranslations('projectForm');
  const te = useTranslations('projectEnums');
  const tc = useTranslations('common');

  // The one heading for this route, rendered by TopHeader.
  usePageHeader(t('title'), t('subtitle'));

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

  const [saving, setSaving]           = useState(false);
  const [error, setError]             = useState('');
  const [employees, setEmployees]     = useState<any[]>([]);
  const [departments, setDepartments] = useState<any[]>([]);
  const [teams, setTeams]             = useState<any[]>([]);
  const [memberSearch, setMemberSearch]         = useState('');
  const [selectedIds, setSelectedIds]           = useState<string[]>([]);
  const [memberPickerOpen, setMemberPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  const [form, setForm] = useState<CreateProjectData>({
    name: '', description: '', color: COLORS[0].hex,
    status: 'PLANNING', priority: 'MEDIUM', visibility: 'PRIVATE', taskPrefix: '',
  });

  useEffect(() => {
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
      } catch {}
    })();
  }, []);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setMemberPickerOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const set    = (k: keyof CreateProjectData, v: any) => setForm(p => ({ ...p, [k]: v }));
  const toggle = (id: string) => setSelectedIds(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) { setError(t('errorNameRequired')); return; }
    setSaving(true); setError('');
    try {
      const payload = {
        ...form,
        startDate:    form.startDate    || undefined,
        endDate:      form.endDate      || undefined,
        departmentId: form.departmentId || undefined,
        teamId:       form.teamId       || undefined,
        ownerId:      form.ownerId      || undefined,
        taskPrefix:   form.taskPrefix   || undefined,
      };
      const res       = await projectService.create(payload) as any;
      const projectId = res.data?.id   || res.id;
      const slug      = res.data?.slug || res.slug;
      if (projectId && selectedIds.length > 0) {
        await projectService.addMember(projectId, selectedIds, 'MEMBER');
      }
      router.push(slug ? `/dashboard/projects/${slug}` : '/dashboard/projects');
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || t('errorCreateFailed'));
      setSaving(false);
    }
  };

  const selectedEmployees = employees.filter(e => selectedIds.includes(e.id));
  const filteredEmployees = employees.filter(e =>
    (e.fullName || '').toLowerCase().includes(memberSearch.toLowerCase()) ||
    (e.employeeCode || '').toLowerCase().includes(memberSearch.toLowerCase()),
  );

  const inp = 'w-full rounded-xl border border-surface-border bg-surface-page px-4 py-2.5 text-sm text-text-body placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-brand-primary/30 transition';
  const selStatus     = STATUSES.find(s => s.value === form.status);
  const selPriority   = PRIORITIES.find(p => p.value === form.priority);
  const selVisibility = VISIBILITIES.find(v => v.value === form.visibility);

  return (
    <ProtectedRoute requiredPermission="CREATE_PROJECT">
      <div className="flex flex-col bg-surface-page" style={{ minHeight: 'calc(100vh - 64px)' }}>

        {/* ── Top bar ───────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between border-b border-surface-border bg-surface-card px-8 py-3 shrink-0">
          <button type="button" onClick={() => router.push('/dashboard/projects')}
            data-testid="project-form-back"
            className="flex items-center gap-2 text-sm text-text-muted hover:text-text-body transition">
            <ArrowLeftIcon className="h-4 w-4" /> {t('backToProjectsBtn')}
          </button>
          <div className="flex items-center gap-3">
            <button type="button" onClick={() => router.push('/dashboard/projects')}
              data-testid="project-form-cancel"
              className="rounded-xl border border-surface-border px-4 py-2 text-sm font-medium text-text-body hover:bg-surface-page transition">
              {tc('cancel')}
            </button>
            <button onClick={submit} disabled={saving || !form.name.trim()}
              data-testid="project-form-submit"
              className="flex items-center gap-2 rounded-xl bg-brand-primary px-5 py-2 text-sm font-semibold text-white hover:bg-brand-primary-dark disabled:opacity-50 disabled:cursor-not-allowed transition">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {saving ? t('creatingBtn') : t('createProjectBtn')}
            </button>
          </div>
        </div>

        {/* ── Two-column body ───────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto">
          <form onSubmit={submit} data-testid="project-form">
            <div className="mx-auto max-w-7xl px-8 py-8">

              {/* The title/subtitle live in the sticky TopHeader, declared via
                  usePageHeader above — the back/cancel/create bar stays. */}

              {error && (
                <div data-testid="project-form-error" className="mb-6 flex items-center gap-2 rounded-xl border border-status-error/30 bg-status-error-bg px-4 py-3 text-sm text-status-error">
                  <AlertCircle className="h-4 w-4 shrink-0" />{error}
                </div>
              )}

              {/* ── Grid ── */}
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_380px] xl:grid-cols-[1fr_420px]">

                {/* ═══ LEFT COLUMN ═══ */}
                <div className="space-y-5 min-w-0">

                  {/* Identity */}
                  <Card title={t('identityHeading')} desc={t('identityDesc')} icon={Tag}>
                    <div className="grid grid-cols-3 gap-3 mb-4">
                      <div className="col-span-2">
                        <Label>{t('projectNameLabel')} <span className="text-status-error">*</span></Label>
                        <input autoFocus value={form.name} onChange={e => set('name', e.target.value)}
                          data-testid="project-form-name"
                          placeholder={t('projectNamePlaceholder')} className={inp} />
                      </div>
                      <div>
                        <Label extra={t('taskPrefixHint')}>{t('taskPrefixLabel')}</Label>
                        <input value={form.taskPrefix} maxLength={8}
                          data-testid="project-form-task-prefix"
                          onChange={e => set('taskPrefix', e.target.value.toUpperCase())}
                          placeholder={t('taskPrefixPlaceholder')} className={`${inp} font-mono uppercase tracking-widest`} />
                      </div>
                    </div>
                    <div className="mb-4">
                      <Label>{tc('description')}</Label>
                      <textarea rows={3} value={form.description}
                        data-testid="project-form-description"
                        onChange={e => set('description', e.target.value)}
                        placeholder={t('descriptionPlaceholder')}
                        className={`${inp} resize-none`} />
                    </div>
                    <div>
                      <Label>{t('projectColorLabel')}</Label>
                      <div data-testid="project-form-color" className="mt-2 flex flex-wrap gap-2.5">
                        {COLORS.map(({ hex, name }) => (
                          <button type="button" key={hex} title={name} onClick={() => set('color', hex)}
                            data-testid={`project-form-color-${hex.replace('#', '')}`}
                            className={`relative h-8 w-8 rounded-full transition-all ${
                              form.color === hex
                                ? 'scale-110 ring-2 ring-offset-2 ring-offset-surface-card shadow-md'
                                : 'opacity-55 hover:opacity-100 hover:scale-105'
                            }`}
                            style={{ backgroundColor: hex, ...(form.color === hex ? { ringColor: hex } : {}) }}>
                            {form.color === hex && <Check className="absolute inset-0 m-auto h-3.5 w-3.5 text-white drop-shadow" />}
                          </button>
                        ))}
                      </div>
                    </div>
                  </Card>

                  {/* Status */}
                  <Card title={tc('status')} desc={t('statusDesc')} icon={Clock}>
                    <div data-testid="project-form-status" className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
                      {STATUSES.map(({ value, label, icon: Icon, desc, color }) => {
                        const sel = form.status === value;
                        return (
                          <button type="button" key={value} onClick={() => set('status', value)}
                            data-testid={`project-form-status-${value}`}
                            className={`relative flex flex-col items-start gap-1.5 rounded-xl border p-3 text-start transition-all ${
                              sel ? 'border-2 shadow-sm' : 'border-surface-border hover:bg-surface-page'
                            }`}
                            style={sel ? { borderColor: color, backgroundColor: `${color}12` } : {}}>
                            <Icon className="h-4 w-4" style={{ color }} />
                            <span className="text-xs font-semibold text-text-heading">{label}</span>
                            <span className="text-[10px] leading-tight text-text-muted">{desc}</span>
                            {sel && (
                              <span className="absolute end-2 top-2 flex h-4 w-4 items-center justify-center rounded-full" style={{ backgroundColor: color }}>
                                <Check className="h-2.5 w-2.5 text-white" />
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </Card>

                  {/* Timeline */}
                  <Card title={t('timelineHeading')} desc={t('timelineDesc')} icon={Calendar}>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <Label>{tc('startDate')}</Label>
                        <input type="date" value={form.startDate || ''} onChange={e => set('startDate', e.target.value)} data-testid="project-form-start-date" className={inp} />
                      </div>
                      <div>
                        <Label>{tc('endDate')}</Label>
                        <input type="date" value={form.endDate || ''} onChange={e => set('endDate', e.target.value)} data-testid="project-form-end-date" className={inp} />
                      </div>
                    </div>
                  </Card>

                  {/* Organization */}
                  <Card title={t('organizationHeading')} desc={t('organizationDesc')} icon={Building2}>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                      <div>
                        <Label>{t('ownerLabel')}</Label>
                        <select value={form.ownerId || ''} onChange={e => set('ownerId', e.target.value)} data-testid="project-form-owner" className={inp}>
                          <option value="">{t('noneOption')}</option>
                          {employees.map(e => <option key={e.id} value={e.id}>{e.fullName}</option>)}
                        </select>
                      </div>
                      <div>
                        <Label>{tc('department')}</Label>
                        <select value={form.departmentId || ''} onChange={e => set('departmentId', e.target.value)} data-testid="project-form-department" className={inp}>
                          <option value="">{t('noneOption')}</option>
                          {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                        </select>
                      </div>
                      <div>
                        <Label>{tc('team')}</Label>
                        <select value={form.teamId || ''} onChange={e => set('teamId', e.target.value)} data-testid="project-form-team" className={inp}>
                          <option value="">{t('noneOption')}</option>
                          {teams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}
                        </select>
                      </div>
                    </div>
                  </Card>

                  {/* Team Members */}
                  <Card title={t('teamMembersHeading')} desc={t('teamMembersDesc')} icon={Users}>
                    <AnimatePresence initial={false}>
                      {selectedEmployees.length > 0 && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
                          className="mb-4 flex flex-wrap gap-2"
                        >
                          {selectedEmployees.map(emp => (
                            <motion.button
                              key={emp.id} type="button"
                              initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.8, opacity: 0 }}
                              onClick={() => toggle(emp.id)}
                              data-testid={`project-form-member-chip-${emp.id}`}
                              className="group flex items-center gap-2 rounded-full border border-surface-border bg-surface-page px-3 py-1.5 transition hover:border-status-error/40 hover:bg-status-error-bg/30"
                            >
                              <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white"
                                style={{ backgroundColor: avatarColor(emp.fullName || '') }}>
                                {initials(emp.fullName || '?')}
                              </div>
                              <span className="max-w-[110px] truncate text-xs font-medium text-text-body">{emp.fullName}</span>
                              <X className="h-3 w-3 text-text-muted opacity-0 transition group-hover:opacity-100 group-hover:text-status-error" />
                            </motion.button>
                          ))}
                        </motion.div>
                      )}
                    </AnimatePresence>

                    <div ref={pickerRef} className="relative">
                      <button type="button" onClick={() => setMemberPickerOpen(v => !v)}
                        data-testid="project-form-members"
                        className={`flex w-full items-center gap-3 rounded-xl border px-4 py-2.5 text-sm transition ${
                          memberPickerOpen ? 'border-brand-primary ring-2 ring-brand-primary/20' : 'border-surface-border bg-surface-page hover:border-brand-primary/40'
                        }`}>
                        <Search className="h-4 w-4 text-text-muted shrink-0" />
                        <span className="flex-1 text-start text-text-muted">
                          {selectedIds.length > 0
                            ? t('membersSelectedSuffix', { count: selectedIds.length })
                            : t('searchAddMembersPlaceholder')}
                        </span>
                        <ChevronDown className={`h-4 w-4 text-text-muted transition-transform ${memberPickerOpen ? 'rotate-180' : ''}`} />
                      </button>

                      <AnimatePresence>
                        {memberPickerOpen && (
                          <motion.div
                            initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
                            transition={{ duration: 0.12 }}
                            data-testid="project-form-member-picker"
                            className="absolute start-0 end-0 top-full z-50 mt-1 overflow-hidden rounded-xl border border-surface-border bg-surface-card shadow-xl"
                          >
                            <div className="flex items-center gap-2 border-b border-surface-border px-4 py-2.5">
                              <Search className="h-4 w-4 shrink-0 text-text-muted" />
                              <input autoFocus value={memberSearch} onChange={e => setMemberSearch(e.target.value)}
                                data-testid="project-form-member-search"
                                placeholder={t('searchByNameCodePlaceholder')}
                                className="flex-1 bg-transparent text-sm text-text-body placeholder:text-text-muted focus:outline-none" />
                              {memberSearch && (
                                <button type="button" onClick={() => setMemberSearch('')} className="text-text-muted hover:text-text-body">
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </div>
                            <div className="flex items-center justify-between border-b border-surface-border bg-surface-page px-4 py-1.5">
                              <span className="text-xs text-text-muted">{t('employeesCountLabel', { count: filteredEmployees.length })}</span>
                              <div className="flex gap-3">
                                <button type="button" onClick={() => setSelectedIds(filteredEmployees.map(e => e.id))}
                                  className="text-xs font-medium text-brand-primary hover:underline">{t('selectAllBtn')}</button>
                                <button type="button" onClick={() => setSelectedIds([])}
                                  className="text-xs text-text-muted hover:underline">{tc('clear')}</button>
                              </div>
                            </div>
                            <ul className="max-h-52 overflow-y-auto py-1">
                              {filteredEmployees.map(emp => {
                                const sel = selectedIds.includes(emp.id);
                                return (
                                  <li key={emp.id}>
                                    <button type="button" onClick={() => toggle(emp.id)}
                                      data-testid={`project-form-member-option-${emp.id}`}
                                      className={`flex w-full items-center gap-3 px-4 py-2.5 text-sm transition hover:bg-surface-page ${sel ? 'bg-brand-primary/5' : ''}`}>
                                      <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition ${sel ? 'border-brand-primary bg-brand-primary' : 'border-surface-border'}`}>
                                        {sel && <Check className="h-2.5 w-2.5 text-white" />}
                                      </span>
                                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
                                        style={{ backgroundColor: avatarColor(emp.fullName || '') }}>
                                        {initials(emp.fullName || '?')}
                                      </div>
                                      <span className="flex-1 text-start">
                                        <span className="block font-medium text-text-body">{emp.fullName}</span>
                                        {emp.employeeCode && <span className="text-[10px] text-text-muted">#{emp.employeeCode}</span>}
                                      </span>
                                      {emp.department?.name && (
                                        <span className="shrink-0 rounded-full border border-surface-border bg-surface-page px-2 py-0.5 text-[10px] text-text-muted">
                                          {emp.department.name}
                                        </span>
                                      )}
                                    </button>
                                  </li>
                                );
                              })}
                              {filteredEmployees.length === 0 && (
                                <li data-testid="project-form-member-empty" className="py-8 text-center text-xs text-text-muted">{t('noEmployeesFoundEmpty')}</li>
                              )}
                            </ul>
                            <div className="flex items-center justify-between border-t border-surface-border bg-surface-page px-4 py-2">
                              <span className="text-xs text-text-muted">{t('selectedCountLabel', { count: selectedIds.length })}</span>
                              <button type="button" onClick={() => setMemberPickerOpen(false)}
                                data-testid="project-form-member-done"
                                className="rounded-lg bg-brand-primary px-4 py-1.5 text-xs font-semibold text-white hover:bg-brand-primary-dark">
                                {t('doneBtn')}
                              </button>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  </Card>

                  <div className="h-4" />
                </div>

                {/* ═══ RIGHT COLUMN (sticky) ═══ */}
                <div className="space-y-5">
                  <div className="sticky top-4 space-y-5">

                    {/* Live preview card */}
                    <div className="rounded-2xl border border-surface-border bg-surface-card p-5 shadow-sm">
                      <p className="mb-4 text-xs font-semibold uppercase tracking-wider text-text-muted">{t('previewLabel')}</p>

                      {/* Avatar + name */}
                      <div className="flex items-start gap-4">
                        <motion.div
                          animate={{ backgroundColor: form.color }}
                          transition={{ duration: 0.2 }}
                          className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl text-xl font-bold text-white shadow-md"
                        >
                          {form.name.trim() ? initials(form.name) : t('initialsPlaceholder')}
                        </motion.div>
                        <div className="min-w-0 flex-1">
                          <p className={`text-base font-bold leading-tight ${form.name ? 'text-text-heading' : 'text-text-muted'}`}>
                            {form.name || t('namePlaceholderPreview')}
                          </p>
                          {form.taskPrefix && (
                            <span className="mt-0.5 inline-block rounded bg-brand-primary/10 px-1.5 py-0.5 font-mono text-[10px] font-bold text-brand-primary">
                              {form.taskPrefix}-###
                            </span>
                          )}
                          <p className="mt-1 text-xs text-text-muted line-clamp-2">
                            {form.description || t('descPlaceholderPreview')}
                          </p>
                        </div>
                      </div>

                      {/* Badges */}
                      <div className="mt-4 flex flex-wrap gap-1.5">
                        {selStatus && (
                          <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
                            style={{ backgroundColor: `${selStatus.color}20`, color: selStatus.color }}>
                            <selStatus.icon className="h-3 w-3" />{selStatus.label}
                          </span>
                        )}
                        {selPriority && (
                          <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
                            style={{ backgroundColor: `${selPriority.color}20`, color: selPriority.color }}>
                            <Flag className="h-3 w-3" />{selPriority.label}
                          </span>
                        )}
                        {selVisibility && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-surface-page border border-surface-border px-2.5 py-0.5 text-[11px] font-semibold text-text-muted">
                            <selVisibility.icon className="h-3 w-3" />{selVisibility.label}
                          </span>
                        )}
                      </div>

                      {/* Dates */}
                      {(form.startDate || form.endDate) && (
                        <div className="mt-3 flex items-center gap-1.5 text-xs text-text-muted">
                          <Calendar className="h-3.5 w-3.5 shrink-0" />
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

                      {/* Team bubbles */}
                      {selectedEmployees.length > 0 && (
                        <div className="mt-4 border-t border-surface-border pt-4">
                          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                            {t('teamCountLabel', { count: selectedEmployees.length })}
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            {selectedEmployees.slice(0, 10).map(emp => (
                              <div key={emp.id} title={emp.fullName}
                                className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-surface-card text-[10px] font-bold text-white shadow"
                                style={{ backgroundColor: avatarColor(emp.fullName || '') }}>
                                {initials(emp.fullName || '?')}
                              </div>
                            ))}
                            {selectedEmployees.length > 10 && (
                              <div className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-surface-border bg-surface-page text-[10px] font-bold text-text-muted">
                                {t('overflowCount', { count: selectedEmployees.length - 10 })}
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Priority */}
                    <div className="rounded-2xl border border-surface-border bg-surface-card p-5">
                      <div className="mb-4 border-b border-surface-border pb-3">
                        <p className="text-sm font-semibold text-text-heading">{t('priorityHeading')}</p>
                        <p className="mt-0.5 text-xs text-text-muted">{t('priorityDesc')}</p>
                      </div>
                      <div data-testid="project-form-priority" className="space-y-2">
                        {PRIORITIES.map(({ value, label, desc, color, dot }) => {
                          const sel = form.priority === value;
                          return (
                            <button type="button" key={value} onClick={() => set('priority', value)}
                              data-testid={`project-form-priority-${value}`}
                              className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-start transition-all ${
                                sel ? 'border-2 shadow-sm' : 'border-surface-border hover:bg-surface-page'
                              }`}
                              style={sel ? { borderColor: color, backgroundColor: `${color}08` } : {}}>
                              <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${dot}`} />
                              <span className="flex-1">
                                <span className="block text-sm font-medium text-text-heading">{label}</span>
                                <span className="text-[10px] text-text-muted">{desc}</span>
                              </span>
                              {sel && <Check className="h-4 w-4 shrink-0" style={{ color }} />}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Visibility */}
                    <div className="rounded-2xl border border-surface-border bg-surface-card p-5">
                      <div className="mb-4 border-b border-surface-border pb-3">
                        <p className="text-sm font-semibold text-text-heading">{t('visibilityHeading')}</p>
                        <p className="mt-0.5 text-xs text-text-muted">{t('visibilityDesc')}</p>
                      </div>
                      <div data-testid="project-form-visibility" className="space-y-2">
                        {VISIBILITIES.map(({ value, label, icon: Icon, desc }) => {
                          const sel = form.visibility === value;
                          return (
                            <button type="button" key={value} onClick={() => set('visibility', value)}
                              data-testid={`project-form-visibility-${value}`}
                              className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-start transition-all ${
                                sel ? 'border-2 border-brand-primary bg-brand-primary/5 shadow-sm' : 'border-surface-border hover:bg-surface-page'
                              }`}>
                              <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition ${sel ? 'bg-brand-primary text-white' : 'bg-surface-page text-text-muted'}`}>
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
                    </div>

                  </div>
                </div>
              </div>
            </div>
          </form>
        </div>
      </div>
    </ProtectedRoute>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Card({ title, desc, icon: Icon, children }: {
  title: string; desc: string; icon?: any; children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-surface-border bg-surface-card p-6">
      <div className="mb-5 border-b border-surface-border pb-4">
        <p className="text-sm font-semibold text-text-heading">{title}</p>
        <p className="mt-0.5 text-xs text-text-muted">{desc}</p>
      </div>
      {children}
    </div>
  );
}

function Label({ extra, children }: { extra?: string; children: React.ReactNode }) {
  return (
    <label className="mb-1.5 block text-xs font-medium text-text-muted">
      {children}
      {extra && <span className="ms-1 text-[10px] font-normal opacity-60">{extra}</span>}
    </label>
  );
}

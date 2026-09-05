'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import {
  Paperclip, Plus, Eye, Trash2, X, Loader2, AlertCircle,
  FileText, Settings2, Users, ChevronDown, Check, MapPin,
} from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import PageActionRow from '@/components/common/PageActionRow';
import { usePermission } from '@/hooks/usePermission';
import { usePageHeader } from '@/hooks/usePageHeader';
import { apiErrorMessage } from '@/utils/apiError';
import projectService from '@/services/projectService';
import projectTaskService from '@/services/projectTaskService';
import sprintService from '@/services/sprintService';
import taskService from '@/services/taskService';
import type { ProjectTaskStatus, Label, Sprint, Project } from '@/types/project';
import { useFlipDrop } from '@/hooks/useFlipDrop';

const NotionEditor: any = dynamic(() => import('@/components/ui/NotionEditor'), { ssr: false });

function SectionHeader({ icon: Icon, title }: { icon: React.ElementType; title: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <Icon className="h-4 w-4 text-brand-primary" />
      <h2 className="text-sm font-semibold text-text-heading">{title}</h2>
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium text-text-body">
        {label} {required && <span className="text-status-error">*</span>}
      </label>
      {children}
    </div>
  );
}

/**
 * R23. `Task.storyPoints` is an int4 column with no server-side bound, so
 * `2147483648` came back as an unmapped 500 — which the form then reported
 * through a native `alert()` reading only "Failed to create task." An estimate
 * is a small number by definition; bounding the input here means the overflow
 * is refused where the user can see the field, not by a stack trace.
 */
const STORY_POINTS_MAX = 999;

const inputCls = 'w-full rounded-[--radius-button] border border-surface-border bg-surface-page px-3 py-2 text-sm text-text-body placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-brand-primary/30';
const selectCls = `${inputCls} cursor-pointer`;

export default function NewTaskPage() {
  const t = useTranslations('taskForm');
  const te = useTranslations('projectEnums');
  const tc = useTranslations('common');
  const params = useParams();
  const router = useRouter();
  const slug = params?.slug as string;
  const { can } = usePermission();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const TASK_TYPES = [
    { value: 'TASK', label: te('taskTypeTask') },
    { value: 'BUG', label: te('taskTypeBug') },
    { value: 'EPIC', label: te('taskTypeEpic') },
    { value: 'STORY', label: te('taskTypeStory') },
    { value: 'SUBTASK', label: te('taskTypeSubtask') },
  ];

  const PRIORITIES = [
    { value: 'LOW', label: te('priorityLow') },
    { value: 'MEDIUM', label: te('priorityMedium') },
    { value: 'HIGH', label: te('priorityHigh') },
    { value: 'URGENT', label: te('priorityUrgent') },
  ];

  const [project, setProject] = useState<Project | null>(null);
  const [statuses, setStatuses] = useState<ProjectTaskStatus[]>([]);
  const [labels, setLabels] = useState<Label[]>([]);
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [members, setMembers] = useState<any[]>([]);
  const [parentTasks, setParentTasks] = useState<any[]>([]);
  const [loadingInit, setLoadingInit] = useState(true);

  // Form state
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [statusId, setStatusId] = useState('');
  const [priority, setPriority] = useState('MEDIUM');
  const [type, setType] = useState('TASK');
  const [parentTaskId, setParentTaskId] = useState('');
  const [storyPoints, setStoryPoints] = useState('');
  const [sprintId, setSprintId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [selectedAssignees, setSelectedAssignees] = useState<any[]>([]);
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [previewFile, setPreviewFile] = useState<{ url: string; name: string; type: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /**
   * R23. Failure is reported IN THE PAGE, the way every other form in this app
   * reports it (`project-form-error` on the project form) — not through
   * `window.alert`. A native dialog cannot be styled, translated, pointed at a
   * field, or read after it is dismissed; `docs/TESTING.md` §Recorded defects
   * #4 records the class Phase 4 fixed for payroll and left everywhere else.
   */
  const [error, setError] = useState<string | null>(null);

  // Location
  const [locationName, setLocationName] = useState('');
  const [latitude, setLatitude] = useState<number | null>(null);
  const [longitude, setLongitude] = useState<number | null>(null);
  const [geoLoading, setGeoLoading] = useState(false);

  // Reporter
  const [reporterId, setReporterId] = useState('');
  const [showReporterPicker, setShowReporterPicker] = useState(false);
  const [reporterSearch, setReporterSearch] = useState('');

  // Assignee picker dropdown
  const [showAssigneePicker, setShowAssigneePicker] = useState(false);
  const [assigneeSearch, setAssigneeSearch] = useState('');

  // Parent task picker
  const [showParentPicker, setShowParentPicker] = useState(false);
  const [parentSearch, setParentSearch] = useState('');

  // Flip-up hooks for absolute dropdowns
  const { ref: parentPickerRef, flipped: parentFlipped } = useFlipDrop<HTMLDivElement>(showParentPicker);
  const { ref: reporterPickerRef, flipped: reporterFlipped } = useFlipDrop<HTMLDivElement>(showReporterPicker);
  const { ref: assigneePickerRef, flipped: assigneeFlipped } = useFlipDrop<HTMLDivElement>(showAssigneePicker);

  // The one heading for this route, rendered by TopHeader. Declared above the
  // loading / not-found early-returns so the hook order never changes; it feeds
  // both TopHeader's title and the leaf crumb of the global breadcrumb trail.
  usePageHeader(t('createNewTaskTitle'));

  const init = useCallback(async () => {
    setLoadingInit(true);
    try {
      const projRes = (await projectService.getBySlug(slug)) as any;
      const proj: Project = projRes.data;
      setProject(proj);

      const [statusRes, labelRes, sprintRes, memberRes] = (await Promise.all([
        projectTaskService.getStatuses(proj.id),
        projectTaskService.getLabels(proj.id),
        sprintService.list(proj.id),
        projectService.getMembers(proj.id),
      ])) as [any, any, any, any];

      const fetchedStatuses: ProjectTaskStatus[] = statusRes.data || [];
      setStatuses(fetchedStatuses);
      const def = fetchedStatuses.find((s) => s.isDefault) || fetchedStatuses[0];
      if (def) setStatusId(def.id);

      setLabels(labelRes.data || []);
      setSprints(sprintRes.data || []);
      setMembers(memberRes.data || []);
    } finally {
      setLoadingInit(false);
    }
  }, [slug]);

  useEffect(() => { if (slug) init(); }, [slug, init]);

  // Load parent tasks when type switches to SUBTASK
  useEffect(() => {
    if (type === 'SUBTASK' && project?.id) {
      projectTaskService.list(project.id, { limit: 100 }).then((res: any) => {
        setParentTasks((res.data || []).filter((t: any) => t.type !== 'SUBTASK'));
      });
    }
  }, [type, project?.id]);

  const formatBytes = (b: number) => {
    if (b === 0) return '0 B';
    const k = 1024;
    const i = Math.floor(Math.log(b) / Math.log(k));
    return `${(b / Math.pow(k, i)).toFixed(1)} ${['B', 'KB', 'MB', 'GB'][i]}`;
  };

  const addFiles = (files: FileList | File[]) => {
    setAttachments((p) => [...p, ...Array.from(files)]);
  };

  const openPreview = (file: File) => {
    setPreviewFile({ url: URL.createObjectURL(file), name: file.name, type: file.type });
  };

  const closePreview = () => {
    if (previewFile) URL.revokeObjectURL(previewFile.url);
    setPreviewFile(null);
  };

  const toggleAssignee = (m: any) => {
    setSelectedAssignees((p) =>
      p.find((a) => a.id === m.id) ? p.filter((a) => a.id !== m.id) : [...p, m],
    );
  };

  const toggleLabel = (id: string) => {
    setSelectedLabels((p) => (p.includes(id) ? p.filter((l) => l !== id) : [...p, id]));
  };

  const filteredMembers = members.filter((m) => {
    const name = (m.employee?.fullName || m.employee?.firstName || '').toLowerCase();
    return name.includes(assigneeSearch.toLowerCase());
  });

  const filteredParent = parentTasks.filter((t) =>
    t.title.toLowerCase().includes(parentSearch.toLowerCase()) ||
    (t.taskCode || '').toLowerCase().includes(parentSearch.toLowerCase()),
  );

  const captureLocation = () => {
    if (!navigator.geolocation) return;
    setGeoLoading(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords;
        setLatitude(lat);
        setLongitude(lng);
        try {
          const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`,
            { headers: { 'Accept-Language': 'en' } },
          );
          const data = await res.json();
          if (data.display_name) {
            setLocationName(data.display_name.split(',').slice(0, 3).join(',').trim());
          }
        } catch { /* ignore */ }
        setGeoLoading(false);
      },
      () => setGeoLoading(false),
      { timeout: 10000 },
    );
  };

  const handleSubmit = async () => {
    setError(null);
    // The submit button is disabled without a title, so this is a backstop
    // rather than the primary guard — but it must still say something, and say
    // it where the title field is.
    if (!title.trim()) { setError(t('errorTitleRequired')); return; }
    const points = storyPoints.trim() ? Number(storyPoints) : undefined;
    if (
      points !== undefined &&
      (!Number.isInteger(points) || points < 0 || points > STORY_POINTS_MAX)
    ) {
      setError(t('errorStoryPointsRange', { max: STORY_POINTS_MAX }));
      return;
    }
    if (!project) return;

    setSubmitting(true);
    try {
      const payload: any = {
        title: title.trim(),
        description: description.trim() || undefined,
        projectId: project.id,
        statusId: statusId || undefined,
        priority,
        type,
        storyPoints: points,
        sprintId: sprintId || undefined,
        parentTaskId: type === 'SUBTASK' ? (parentTaskId || undefined) : undefined,
        startDate: startDate || undefined,
        dueDate: dueDate || undefined,
        assigneeIds: selectedAssignees.map((a) => a.employee?.id || a.id),
        reporterId: reporterId || undefined,
        labelIds: selectedLabels,
        locationName: locationName.trim() || undefined,
        latitude: latitude ?? undefined,
        longitude: longitude ?? undefined,
      };

      const res = (await projectTaskService.create(payload)) as any;
      const newTaskId: string = res.data?.id;

      // Upload attachments sequentially
      for (const file of attachments) {
        try { await taskService.uploadAttachment(newTaskId, file); } catch { /* ignore individual upload failures */ }
      }

      router.push(`/dashboard/projects/${slug}`);
    } catch (err: any) {
      setError(apiErrorMessage(err, t('errorCreateFailed')));
    } finally {
      setSubmitting(false);
    }
  };

  if (loadingInit) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-brand-primary" />
      </div>
    );
  }

  if (!project) {
    return <div className="py-16 text-center text-text-muted">Project not found.</div>;
  }

  const selectedParentTask = parentTasks.find((t) => t.id === parentTaskId);

  return (
    <ProtectedRoute requiredPermission="VIEW_PROJECTS">
      <div className="flex flex-col min-h-[calc(100svh-4rem)]" data-testid="ess-task-new">
        {/* DashboardLayout renders PageBreadcrumbs for every route, so the trail
            this page used to hand-write was a second trail answering the same
            question, and the `<h1>` under it repeated the title TopHeader now
            paints from usePageHeader. Only the back control survives here. */}
        <div className="mb-5">
          <PageActionRow onBack={() => router.push(`/dashboard/projects/${slug}`)} />
          {error && (
            <div data-testid="task-form-error" className="mt-4 flex items-center gap-2 rounded-xl border border-status-error/30 bg-status-error-bg px-4 py-3 text-sm text-status-error">
              <AlertCircle className="h-4 w-4 shrink-0" />{error}
            </div>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-3 gap-6 pb-24">
          {/* ─── Left column ───────────────────────────────────────── */}
          <div className="lg:col-span-2 space-y-5">
            {/* Basic Information */}
            <div className="rounded-[--radius-card] border border-surface-border bg-surface-card p-5">
              <SectionHeader icon={FileText} title="Basic Information" />
              <Field label={t('titleLabel')} required>
                <input
                  type="text"
                  value={title}
                  data-testid="task-form-title"
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={t('titlePlaceholder')}
                  className={inputCls}
                  autoFocus
                />
              </Field>
            </div>

            {/* Attachments */}
            <div className="rounded-[--radius-card] border border-surface-border bg-surface-card p-5">
              <div className="flex items-center justify-between mb-3">
                <SectionHeader icon={Paperclip} title={`${t('attachmentsHeading')}${attachments.length > 0 ? ` (${attachments.length})` : ''}`} />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  data-testid="task-form-attachment-add"
                  className="flex items-center gap-1.5 rounded-[--radius-button] bg-brand-primary px-3 py-1.5 text-xs font-medium text-text-on-brand hover:bg-brand-primary-dark"
                >
                  <Plus className="h-3.5 w-3.5" /> {t('addAttachmentBtn')}
                </button>
                <input ref={fileInputRef} type="file" multiple data-testid="task-form-attachment-input" className="hidden" onChange={(e) => e.target.files && addFiles(e.target.files)} />
              </div>

              {/* Drag-drop zone */}
              <div
                onDragEnter={(e) => { e.preventDefault(); setIsDragging(true); }}
                onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); setIsDragging(false); addFiles(e.dataTransfer.files); }}
                className={`rounded-[--radius-button] border-2 border-dashed transition ${isDragging ? 'border-brand-primary bg-brand-primary/5' : 'border-surface-border'}`}
              >
                {attachments.length === 0 ? (
                  <div data-testid="task-form-attachment-empty" className="flex items-center justify-center py-8 text-sm text-text-muted">
                    {t('emptyNoAttachments')}
                  </div>
                ) : (
                  <div className="space-y-2 p-3 max-h-64 overflow-y-auto">
                    {attachments.map((file, i) => (
                      <div key={i} data-testid={`task-form-attachment-row-${i}`} className="flex items-center gap-3 rounded-[--radius-button] border border-surface-border bg-surface-page p-2.5">
                        <Paperclip className="h-4 w-4 flex-shrink-0 text-text-muted" />
                        <div className="flex-1 min-w-0">
                          <p className="truncate text-sm font-medium text-text-body">{file.name}</p>
                          <p className="text-xs text-text-muted">{formatBytes(file.size)}</p>
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          {(file.type.startsWith('image/') || file.type === 'application/pdf' || file.type.startsWith('video/')) && (
                            <button type="button" onClick={() => openPreview(file)} data-testid={`task-form-attachment-preview-${i}`} className="rounded p-1 hover:bg-surface-page text-text-muted hover:text-text-body">
                              <Eye className="h-4 w-4" />
                            </button>
                          )}
                          <button type="button" onClick={() => setAttachments((p) => p.filter((_, j) => j !== i))} data-testid={`task-form-attachment-remove-${i}`} className="rounded p-1 text-status-error hover:bg-status-error-bg">
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Description */}
            <div className="rounded-[--radius-card] border border-surface-border bg-surface-card p-5">
              <SectionHeader icon={FileText} title={tc('description')} />
              <div data-testid="task-form-description">
              <NotionEditor
                value={description}
                onChange={setDescription}
                minHeight={300}
                placeholder="Write a description…  Type '#' for a heading, '-' for a bullet, '[]' for a checkbox"
              />
              </div>
              <p className="mt-2 text-xs text-text-muted">
                {t('tipMarkdown')}
              </p>
            </div>
          </div>

          {/* ─── Right column ──────────────────────────────────────── */}
          <div className="lg:col-span-1 space-y-5">
            {/* Project Info */}
            <div className="rounded-[--radius-card] border border-surface-border bg-surface-card p-5">
              <SectionHeader icon={Settings2} title={t('projectHeading')} />
              <Field label={t('projectHeading')}>
                <input
                  type="text"
                  value={project.name}
                  readOnly
                  className={`${inputCls} cursor-not-allowed opacity-70`}
                />
              </Field>
              {project.department && (
                <div className="mt-3">
                  <Field label={tc('department')}>
                    <input type="text" value={(project.department as any).name || ''} readOnly className={`${inputCls} cursor-not-allowed opacity-70`} />
                  </Field>
                </div>
              )}
            </div>

            {/* Task Configuration */}
            <div className="rounded-[--radius-card] border border-surface-border bg-surface-card p-5 space-y-4">
              <SectionHeader icon={Settings2} title={t('taskConfigHeading')} />

              <Field label={t('statusLabel')}>
                <select value={statusId} onChange={(e) => setStatusId(e.target.value)} data-testid="task-status-select" className={selectCls}>
                  {statuses.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
                <p className="text-xs text-text-muted mt-1">{t('statusHelper')}</p>
              </Field>

              <Field label={t('priorityLabel')} required>
                <select value={priority} onChange={(e) => setPriority(e.target.value)} data-testid="task-priority-select" className={selectCls}>
                  {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </Field>

              <Field label={t('taskTypeLabel')} required>
                <select value={type} onChange={(e) => setType(e.target.value)} data-testid="task-form-type" className={selectCls}>
                  {TASK_TYPES.map((tt) => <option key={tt.value} value={tt.value}>{tt.label}</option>)}
                </select>
              </Field>

              {/* Parent Task — only when SUBTASK */}
              {type === 'SUBTASK' && (
                <Field label={t('parentTaskLabel')} required>
                  <div className="relative" ref={parentPickerRef}>
                    <button
                      type="button"
                      onClick={() => setShowParentPicker((p) => !p)}
                      data-testid="task-form-parent"
                      className={`${inputCls} flex items-center justify-between text-start`}
                    >
                      <span className={selectedParentTask ? 'text-text-body' : 'text-text-muted'}>
                        {selectedParentTask ? `${selectedParentTask.taskCode} — ${selectedParentTask.title}` : t('selectParentTaskPlaceholder')}
                      </span>
                      <ChevronDown className="h-4 w-4 flex-shrink-0 text-text-muted" />
                    </button>
                    {showParentPicker && (
                      <div className={`absolute inset-x-0 z-30 rounded-[--radius-card] border border-surface-border bg-surface-card shadow-lg ${parentFlipped ? 'bottom-full mb-1' : 'top-full mt-1'}`}>
                        <div className="p-2 border-b border-surface-border">
                          <input
                            type="text"
                            value={parentSearch}
                            data-testid="task-form-parent-search"
                            onChange={(e) => setParentSearch(e.target.value)}
                            placeholder={t('searchTasksPlaceholder')}
                            className={`${inputCls} py-1.5`}
                            autoFocus
                          />
                        </div>
                        <div className="max-h-48 overflow-y-auto">
                          {filteredParent.length === 0 ? (
                            <p data-testid="task-form-parent-empty" className="py-4 text-center text-xs text-text-muted">{t('emptyNoTasksFound')}</p>
                          ) : filteredParent.slice(0, 8).map((pt) => (
                            <button
                              key={pt.id}
                              type="button"
                              onClick={() => { setParentTaskId(pt.id); setShowParentPicker(false); }}
                              data-testid={`task-form-parent-option-${pt.taskCode}`}
                              className="flex w-full items-center gap-2 px-3 py-2 text-start text-sm hover:bg-surface-page"
                            >
                              <Check className={`h-3.5 w-3.5 flex-shrink-0 ${parentTaskId === pt.id ? 'text-brand-primary' : 'opacity-0'}`} />
                              <span className="truncate">
                                <span className="text-text-muted me-1">{pt.taskCode}</span>{pt.title}
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </Field>
              )}

              <Field label={t('storyPointsLabel')}>
                <input
                  type="number"
                  min={0}
                  max={STORY_POINTS_MAX}
                  step={1}
                  value={storyPoints}
                  data-testid="task-form-story-points"
                  onChange={(e) => setStoryPoints(e.target.value)}
                  placeholder={t('storyPointsPlaceholder')}
                  className={inputCls}
                />
              </Field>

              <Field label={t('sprintLabel')}>
                <select value={sprintId} onChange={(e) => setSprintId(e.target.value)} data-testid="task-form-sprint" className={selectCls}>
                  <option value="">{t('selectSprintOption')}</option>
                  {sprints.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </Field>

              <Field label={t('startDateLabel')}>
                <input
                  type="date"
                  value={startDate}
                  data-testid="task-form-start-date"
                  onChange={(e) => { setStartDate(e.target.value); if (dueDate && e.target.value > dueDate) setDueDate(''); }}
                  max={dueDate || undefined}
                  className={`${inputCls} cursor-pointer`}
                />
              </Field>

              <Field label={t('dueDateLabel')}>
                <input
                  type="date"
                  value={dueDate}
                  data-testid="task-form-due-date"
                  min={startDate || undefined}
                  onChange={(e) => setDueDate(e.target.value)}
                  className={`${inputCls} cursor-pointer`}
                />
              </Field>
            </div>

            {/* Labels */}
            {labels.length > 0 && (
              <div className="rounded-[--radius-card] border border-surface-border bg-surface-card p-5">
                <SectionHeader icon={Settings2} title={t('labelsHeading')} />
                <div className="flex flex-wrap gap-2">
                  {labels.map((l) => (
                    <button
                      key={l.id}
                      type="button"
                      onClick={() => toggleLabel(l.id)}
                      data-testid={`task-form-label-${l.id}`}
                      className={`rounded-full px-3 py-1 text-xs font-medium border-2 transition ${selectedLabels.includes(l.id) ? 'border-current' : 'border-transparent opacity-60 hover:opacity-90'}`}
                      style={{ backgroundColor: `${l.color}22`, color: l.color }}
                    >
                      {selectedLabels.includes(l.id) && <Check className="inline h-3 w-3 me-1" />}
                      {l.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Location */}
            <div className="rounded-[--radius-card] border border-surface-border bg-surface-card p-5">
              <SectionHeader icon={MapPin} title={t('locationLabel')} />
              <div className="space-y-3">
                <Field label={t('locationNameLabel')}>
                  <input
                    type="text"
                    value={locationName}
                    data-testid="task-form-location-name"
                    onChange={(e) => setLocationName(e.target.value)}
                    placeholder={t('locationNamePlaceholder')}
                    className={inputCls}
                  />
                </Field>
                <button
                  type="button"
                  onClick={captureLocation}
                  data-testid="task-form-location-capture"
                  disabled={geoLoading}
                  className="flex w-full items-center justify-center gap-2 rounded-[--radius-button] border border-surface-border py-2 text-sm text-text-muted hover:bg-surface-page disabled:opacity-50"
                >
                  {geoLoading
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : <MapPin className="h-4 w-4" />}
                  {geoLoading ? t('detectingLocationBtn') : t('useMyLocationBtn')}
                </button>
                {latitude != null && longitude != null && (
                  <div className="flex items-center justify-between rounded-[--radius-button] border border-surface-border bg-surface-page px-3 py-2">
                    <a
                      href={`https://maps.google.com/?q=${latitude},${longitude}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 text-xs text-brand-primary hover:underline"
                    >
                      <MapPin className="h-3.5 w-3.5" />
                      {latitude.toFixed(5)}, {longitude.toFixed(5)}
                    </a>
                    <button
                      type="button"
                      onClick={() => { setLatitude(null); setLongitude(null); setLocationName(''); }}
                      className="text-xs text-status-error hover:underline"
                    >
                      {t('clearBtn')}
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Assignment */}
            <div className="rounded-[--radius-card] border border-surface-border bg-surface-card p-5">
              <SectionHeader icon={Users} title={t('assignmentHeading')} />

              {/* Reporter — single-select */}
              <Field label={t('reporterLabel')}>
                <div className="relative" ref={reporterPickerRef}>
                  {reporterId ? (
                    <div className="flex items-center gap-2 rounded-[--radius-button] border border-surface-border bg-surface-page px-3 py-2">
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-primary/20 text-xs font-bold text-brand-primary">
                        {(() => { const m = members.find((m) => m.employee?.id === reporterId); const n = m?.employee?.fullName || m?.employee?.firstName || '?'; return n.charAt(0).toUpperCase(); })()}
                      </div>
                      <span className="flex-1 text-sm text-text-body">
                        {(() => { const m = members.find((m) => m.employee?.id === reporterId); return m?.employee?.fullName || m?.employee?.firstName || t('fallbackMember'); })()}
                      </span>
                      <button type="button" onClick={() => setReporterId('')} data-testid="task-form-reporter-clear" className="text-text-muted hover:text-status-error">
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => { setShowReporterPicker((p) => !p); setShowAssigneePicker(false); }}
                      data-testid="task-form-reporter"
                      className={`${inputCls} flex items-center justify-between text-start`}
                    >
                      <span className="text-text-muted">{t('selectReporterPlaceholder')}</span>
                      <ChevronDown className="h-4 w-4 shrink-0 text-text-muted" />
                    </button>
                  )}
                  {showReporterPicker && !reporterId && (
                    <div className={`absolute inset-x-0 z-30 rounded-[--radius-card] border border-surface-border bg-surface-card shadow-lg ${reporterFlipped ? 'bottom-full mb-1' : 'top-full mt-1'}`}>
                      <div className="p-2 border-b border-surface-border">
                        <input
                          type="text"
                          value={reporterSearch}
                          data-testid="task-form-reporter-search"
                          onChange={(e) => setReporterSearch(e.target.value)}
                          placeholder={t('searchMembersPlaceholder')}
                          className={`${inputCls} py-1.5`}
                          autoFocus
                        />
                      </div>
                      <div className="max-h-48 overflow-y-auto">
                        {members.filter((m) => (m.employee?.fullName || m.employee?.firstName || '').toLowerCase().includes(reporterSearch.toLowerCase())).length === 0 ? (
                          <p data-testid="task-form-reporter-empty" className="py-4 text-center text-xs text-text-muted">{t('emptyNoMembersFound')}</p>
                        ) : members.filter((m) => (m.employee?.fullName || m.employee?.firstName || '').toLowerCase().includes(reporterSearch.toLowerCase())).map((m) => {
                          const name = m.employee?.fullName || m.employee?.firstName || t('fallbackUnknown');
                          return (
                            <button
                              key={m.id}
                              type="button"
                              onClick={() => { setReporterId(m.employee?.id || ''); setShowReporterPicker(false); setReporterSearch(''); }}
                              data-testid={`task-form-reporter-option-${m.employee?.id}`}
                              className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-surface-page"
                            >
                              <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-brand-primary/20 text-xs font-bold text-brand-primary">
                                {name.charAt(0).toUpperCase()}
                              </div>
                              <span className="truncate text-text-body">{name}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </Field>

              <Field label={t('assigneesLabel')}>
                {/* Selected assignees chips */}
                {selectedAssignees.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {selectedAssignees.map((a) => {
                      const name = a.employee?.fullName || a.employee?.firstName || a.fullName || t('fallbackUnknown');
                      return (
                        <span key={a.id} className="flex items-center gap-1 rounded-full bg-brand-primary/10 px-2.5 py-1 text-xs text-brand-primary">
                          {name}
                          <button type="button" onClick={() => toggleAssignee(a)} data-testid={`task-form-assignee-chip-remove-${a.id}`} className="ms-0.5 hover:text-status-error">
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      );
                    })}
                  </div>
                )}
                {/* Dropdown */}
                <div className="relative" ref={assigneePickerRef}>
                  <button
                    type="button"
                    onClick={() => setShowAssigneePicker((p) => !p)}
                    data-testid="task-assignee-select"
                    className={`${inputCls} flex items-center justify-between text-start`}
                  >
                    <span className="text-text-muted">{t('selectAssigneesPlaceholder')}</span>
                    <ChevronDown className="h-4 w-4 flex-shrink-0 text-text-muted" />
                  </button>
                  {showAssigneePicker && (
                    <div className={`absolute inset-x-0 z-30 rounded-[--radius-card] border border-surface-border bg-surface-card shadow-lg ${assigneeFlipped ? 'bottom-full mb-1' : 'top-full mt-1'}`}>
                      <div className="p-2 border-b border-surface-border">
                        <input
                          type="text"
                          value={assigneeSearch}
                          data-testid="task-form-assignee-search"
                          onChange={(e) => setAssigneeSearch(e.target.value)}
                          placeholder={t('searchMembersPlaceholder')}
                          className={`${inputCls} py-1.5`}
                          autoFocus
                        />
                      </div>
                      <div className="max-h-48 overflow-y-auto">
                        {members.length === 0 ? (
                          <p data-testid="task-form-assignee-empty" className="py-4 text-center text-xs text-text-muted">{t('emptyNoMembersInProject')}</p>
                        ) : filteredMembers.length === 0 ? (
                          <p data-testid="task-form-assignee-no-match" className="py-4 text-center text-xs text-text-muted">{t('emptyNoMatch')}</p>
                        ) : filteredMembers.map((m) => {
                          const name = m.employee?.fullName || m.employee?.firstName || t('fallbackUnknown');
                          const isSelected = selectedAssignees.some((a) => a.id === m.id);
                          return (
                            <button
                              key={m.id}
                              type="button"
                              onClick={() => toggleAssignee(m)}
                              data-testid={`task-form-assignee-option-${m.id}`}
                              className={`flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-surface-page ${isSelected ? 'bg-brand-primary/5' : ''}`}
                            >
                              <div className={`h-4 w-4 flex-shrink-0 rounded border ${isSelected ? 'border-brand-primary bg-brand-primary' : 'border-surface-border'} flex items-center justify-center`}>
                                {isSelected && <Check className="h-3 w-3 text-white" />}
                              </div>
                              <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-brand-primary/20 text-xs font-bold text-brand-primary">
                                {name.charAt(0).toUpperCase()}
                              </div>
                              <span className="truncate text-text-body">{name}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </Field>
            </div>
          </div>
        </div>

        {/* Sticky footer */}
        <div className="fixed bottom-0 inset-x-0 z-20 border-t border-surface-border bg-surface-page/90 backdrop-blur-sm px-6 py-3">
          <div className="mx-auto flex max-w-screen-xl items-center justify-end gap-3">
            <button
              type="button"
              onClick={() => router.push(`/dashboard/projects/${slug}`)}
              data-testid="task-form-cancel"
              className="rounded-[--radius-button] border border-surface-border bg-surface-card px-5 py-2 text-sm font-medium text-text-body hover:bg-surface-page"
            >
              {t('cancelBtn')}
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting || !title.trim()}
              data-testid="task-form-submit"
              className="flex items-center gap-2 rounded-[--radius-button] bg-brand-primary px-6 py-2 text-sm font-semibold text-text-on-brand hover:bg-brand-primary-dark disabled:opacity-60"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {submitting ? t('creatingBtn') : t('createTaskBtn')}
            </button>
          </div>
        </div>
      </div>

      {/* File preview modal */}
      {previewFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={closePreview}>
          <div className="relative max-h-[90vh] w-full max-w-4xl mx-4 overflow-hidden rounded-[--radius-card] bg-surface-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-surface-border p-4">
              <p className="truncate text-sm font-medium text-text-body">{previewFile.name}</p>
              <button onClick={closePreview} className="rounded p-1.5 hover:bg-surface-page text-text-muted">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="flex max-h-[calc(90vh-64px)] items-center justify-center overflow-auto p-4">
              {previewFile.type.startsWith('image/') && <img src={previewFile.url} alt={previewFile.name} className="max-h-[75vh] max-w-full rounded object-contain" />}
              {previewFile.type === 'application/pdf' && <iframe src={previewFile.url} className="h-[75vh] w-full rounded" title={previewFile.name} />}
              {previewFile.type.startsWith('video/') && <video src={previewFile.url} controls className="max-h-[75vh] max-w-full rounded" />}
            </div>
          </div>
        </div>
      )}
    </ProtectedRoute>
  );
}

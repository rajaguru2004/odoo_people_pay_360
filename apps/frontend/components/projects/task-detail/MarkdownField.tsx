'use client';

import React, { useState } from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { Pencil, Check, X, Loader2, FileText, Plus } from 'lucide-react';

// Editors use `window`; load client-side only.
const NotionEditor: any = dynamic(() => import('@/components/ui/NotionEditor'), { ssr: false });
const Markdown: any = dynamic(
  () => import('@uiw/react-md-editor').then((m) => (m.default as any).Markdown),
  { ssr: false },
);
import '@uiw/react-md-editor/markdown-editor.css';

interface Props {
  value: string;
  onSave: (val: string) => Promise<void> | void;
  canEdit?: boolean;
  placeholder?: string;
  /** Show the "Description" header row. Defaults to true. */
  showHeader?: boolean;
}

export default function MarkdownField({
  value,
  onSave,
  canEdit = true,
  placeholder: placeholderProp,
  showHeader = true,
}: Props) {
  const t = useTranslations('markdownField');
  const tc = useTranslations('common');
  const placeholder = placeholderProp ?? t('defaultPlaceholder');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || '');
  const [saving, setSaving] = useState(false);

  const start = () => { if (!canEdit) return; setDraft(value || ''); setEditing(true); };
  const cancel = () => setEditing(false);
  const save = async () => {
    setSaving(true);
    try { await onSave(draft); setEditing(false); }
    finally { setSaving(false); }
  };

  return (
    <div data-color-mode="light">
      {showHeader && (
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-brand-primary" />
            <h2 className="text-sm font-semibold text-text-heading">{t('heading')}</h2>
          </div>
          {canEdit && !editing && value && (
            <button
              onClick={start}
              data-testid="task-detail-description-edit"
              className="flex items-center gap-1 rounded-[--radius-button] border border-surface-border bg-surface-card px-2 py-1 text-xs text-text-muted transition hover:text-text-body"
            >
              <Pencil className="h-3 w-3" /> {tc('edit')}
            </button>
          )}
        </div>
      )}

      {editing ? (
        <div className="space-y-2">
          <NotionEditor
            value={draft}
            onChange={setDraft}
            minHeight={200}
            placeholder={t('editorPlaceholder')}
          />
          <div className="flex justify-end gap-2">
            <button
              onClick={cancel}
              data-testid="task-detail-description-cancel"
              className="flex items-center gap-1 rounded-[--radius-button] border border-surface-border px-3 py-1.5 text-sm text-text-body hover:bg-surface-page"
            >
              <X className="h-3.5 w-3.5" /> {tc('cancel')}
            </button>
            <button
              onClick={save}
              disabled={saving}
              data-testid="task-detail-description-save"
              className="flex items-center gap-1 rounded-[--radius-button] bg-brand-primary px-3 py-1.5 text-sm text-text-on-brand hover:bg-brand-primary-dark disabled:opacity-60"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} {tc('save')}
            </button>
          </div>
        </div>
      ) : value ? (
        <div
          onClick={start}
          data-testid="task-detail-description"
          className={`prose-sm max-w-none rounded-[--radius-button] px-3 py-2 text-sm text-text-body transition ${canEdit ? 'cursor-text hover:bg-surface-page' : ''}`}
          title={canEdit ? t('clickToEditTooltip') : undefined}
        >
          <Markdown source={value} style={{ background: 'transparent', color: 'inherit', fontSize: 14 }} />
        </div>
      ) : canEdit ? (
        <button
          onClick={start}
          data-testid="task-detail-description-add"
          className="flex w-full items-center gap-2 rounded-[--radius-button] border border-dashed border-surface-border px-3 py-3 text-sm text-text-muted transition hover:border-brand-primary hover:text-text-body"
        >
          <Plus className="h-4 w-4" /> {placeholder}
        </button>
      ) : (
        <p data-testid="task-detail-description-empty" className="text-sm text-text-muted">{t('emptyNoDescription')}</p>
      )}
    </div>
  );
}

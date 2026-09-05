'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Eye,
  Loader2,
  Plus,
  Trash2,
  Undo2,
} from 'lucide-react';
import documentTemplateService from '@/services/documentTemplateService';
import { getApiErrorMessage } from '@/lib/apiError';
import {
  BLOCK_LABELS,
  duplicateBlock,
  insertBlock,
  makeBlock,
  moveBlock,
  removeBlock,
  replaceBlock,
} from '@/lib/document-template/blocks';
import { canPublish, validateDoc } from '@/lib/document-template/validate';
import { diffDocs } from '@/lib/document-template/diff';
import {
  Block,
  BlockType,
  DocumentAssetSummary,
  DocumentTemplateDoc,
  TokenManifest,
  ValidationIssue,
} from '@/types/document-template';
import BlockInspector from './BlockInspector';

/** Bounded so a long session cannot grow the heap without limit. */
const UNDO_LIMIT = 50;

const PALETTE: BlockType[] = [
  'heading',
  'text',
  'keyValue',
  'dataTable',
  'signature',
  'logo',
  'divider',
  'spacer',
  'pageBreak',
];

export interface TemplateBuilderProps {
  versionId: string;
  initialDoc: DocumentTemplateDoc;
  initialUpdatedAt: string;
  manifest: TokenManifest | null;
  canPublishTemplate: boolean;
  publishedDoc: DocumentTemplateDoc | null;
  /** Letterhead currently pinned to this draft. */
  initialLetterheadId?: string | null;
  onPublished?: () => void;
}

/**
 * The block builder.
 *
 * Reordering is available from BUTTONS as well as drag, and that is not only an
 * accessibility decision: a drag-only builder is unusable to a keyboard user
 * AND untestable in jsdom, so the accessible path and the testable path are the
 * same path. The happy alignment is why there is no pointer-drag-only affordance
 * anywhere in this component.
 */
export default function TemplateBuilder({
  versionId,
  initialDoc,
  initialUpdatedAt,
  manifest,
  canPublishTemplate,
  publishedDoc,
  initialLetterheadId = null,
  onPublished,
}: TemplateBuilderProps) {
  const [doc, setDoc] = useState<DocumentTemplateDoc>(initialDoc);
  const [selectedId, setSelectedId] = useState<string | null>(initialDoc.body[0]?.id ?? null);
  const [updatedAt, setUpdatedAt] = useState(initialUpdatedAt);
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [letterheads, setLetterheads] = useState<DocumentAssetSummary[]>([]);
  const [letterheadId, setLetterheadId] = useState<string | null>(initialLetterheadId);
  const undoStack = useRef<DocumentTemplateDoc[]>([]);

  // The letterhead list is loaded here rather than on the letterhead page
  // alone, because choosing one is part of designing the template — sending
  // somebody to another screen to pick their own stationery is how it stayed
  // undiscoverable.
  useEffect(() => {
    documentTemplateService
      .listAssets('LETTERHEAD')
      .then((list) => setLetterheads(list.filter((a) => a.isActive)))
      .catch(() => setLetterheads([]));
  }, []);

  const issues: ValidationIssue[] = useMemo(
    () => validateDoc(doc, manifest),
    [doc, manifest],
  );
  const publishable = canPublish(issues);
  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warning');

  const selected = doc.body.find((b) => b.id === selectedId) ?? null;

  const apply = useCallback((next: DocumentTemplateDoc) => {
    setDoc((prev) => {
      undoStack.current = [prev, ...undoStack.current].slice(0, UNDO_LIMIT);
      return next;
    });
    setSaveState('idle');
  }, []);

  const undo = useCallback(() => {
    const [prev, ...rest] = undoStack.current;
    if (!prev) return;
    undoStack.current = rest;
    setDoc(prev);
    setSaveState('idle');
  }, []);

  const setBody = useCallback(
    (body: Block[]) => apply({ ...doc, body }),
    [apply, doc],
  );

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = await documentTemplateService.saveDraft(versionId, {
        doc,
        // Sent so a save that would overwrite somebody else's edit answers 409
        // instead of silently winning.
        expectedUpdatedAt: updatedAt,
        letterheadId,
      });
      setUpdatedAt(saved.updatedAt);
      setSaveState('saved');
      if (saved.removed?.length) {
        setError(
          `Some markup was removed for safety: ${saved.removed.join(', ')}. The rest of your design was kept.`,
        );
      }
    } catch (err) {
      setSaveState('error');
      setError(getApiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }, [doc, updatedAt, versionId, letterheadId]);

  const preview = useCallback(async () => {
    setPreviewing(true);
    setError(null);
    try {
      // HTML, not PDF: this is the preview that works on a deployment with no
      // Chromium, and it is the exact compiled markup rather than a second
      // implementation of the layout.
      const res = await documentTemplateService.previewHtml({
        doc,
        typeKey: doc.documentType,
        // So the preview shows the artwork the finished document will carry,
        // rather than a blank page the author has to imagine it behind.
        letterheadId: letterheadId ?? undefined,
      });
      setPreviewHtml(res.html);
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      setPreviewing(false);
    }
  }, [doc, letterheadId]);

  const publish = useCallback(async () => {
    setPublishing(true);
    setError(null);
    try {
      const saved = await documentTemplateService.saveDraft(versionId, {
        doc,
        expectedUpdatedAt: updatedAt,
        letterheadId,
      });
      await documentTemplateService.publish(versionId, saved.contentHash);
      onPublished?.();
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      setPublishing(false);
    }
  }, [doc, updatedAt, versionId, letterheadId, onPublished]);

  // Autosave is safe here precisely BECAUSE a draft generates nothing: the
  // published version is what documents are made from, so an in-progress edit
  // can never reach an employee.
  useEffect(() => {
    if (saveState !== 'idle') return;
    const t = setTimeout(() => void save(), 2000);
    return () => clearTimeout(t);
  }, [doc, saveState, save]);

  const changes = useMemo(() => diffDocs(publishedDoc, doc), [publishedDoc, doc]);

  return (
    <div className="flex flex-col lg:flex-row gap-4" data-testid="template-builder">
      {/* ── Palette and outline ─────────────────────────────────────────── */}
      <aside className="lg:w-56 shrink-0 space-y-4">
        <section>
          <h2 className="text-xs uppercase tracking-wide text-text-muted mb-2">Add a block</h2>
          <div className="grid grid-cols-2 lg:grid-cols-1 gap-1">
            {PALETTE.map((type) => (
              <button
                key={type}
                type="button"
                className="h-10 px-2 text-left text-sm rounded-[--radius-button] surface-panel border-surface-border border hover:shadow-sm"
                onClick={() => {
                  const block = makeBlock(type);
                  setBody(insertBlock(doc.body, block));
                  setSelectedId(block.id);
                }}
              >
                <Plus className="inline h-3 w-3 me-1" />
                {BLOCK_LABELS[type]}
              </button>
            ))}
          </div>
        </section>
      </aside>

      {/* ── Canvas ──────────────────────────────────────────────────────── */}
      <main className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <button
            type="button"
            onClick={undo}
            disabled={undoStack.current.length === 0}
            className="h-10 px-3 rounded-[--radius-button] surface-panel border-surface-border border text-sm disabled:opacity-40"
          >
            <Undo2 className="inline h-4 w-4 me-1" /> Undo
          </button>
          <button
            type="button"
            onClick={() => void preview()}
            className="h-10 px-3 rounded-[--radius-button] surface-panel border-surface-border border text-sm"
          >
            {previewing ? (
              <Loader2 className="inline h-4 w-4 me-1 animate-spin" />
            ) : (
              <Eye className="inline h-4 w-4 me-1" />
            )}
            Preview
          </button>
          <span className="text-xs text-text-muted" data-testid="save-state">
            {saving ? 'Saving…' : saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Save failed' : 'Unsaved changes'}
          </span>
          <div className="ms-auto flex items-center gap-2">
            {canPublishTemplate && (
              <button
                type="button"
                onClick={() => void publish()}
                disabled={!publishable || publishing}
                title={
                  publishable
                    ? undefined
                    : 'Fix the problems listed below before publishing.'
                }
                className="h-10 px-4 rounded-[--radius-button] bg-brand-primary text-text-on-brand text-sm disabled:opacity-40"
                data-testid="publish-button"
              >
                {publishing ? 'Publishing…' : 'Publish'}
              </button>
            )}
          </div>
        </div>

        {error && (
          <div role="alert" className="mb-3 rounded-[--radius-card] border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            {error}
          </div>
        )}

        <ol className="space-y-2" data-testid="block-list">
          {doc.body.map((block, index) => (
            <li key={block.id}>
              <div
                className={`rounded-[--radius-card] border p-3 ${
                  block.id === selectedId ? 'border-brand-primary' : 'border-surface-border'
                } bg-surface-card`}
              >
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="flex-1 text-start text-sm"
                    onClick={() => setSelectedId(block.id)}
                    aria-current={block.id === selectedId}
                  >
                    <span className="font-medium">{BLOCK_LABELS[block.type] ?? block.type}</span>
                    {block.locked && <span className="ms-2 text-xs text-amber-700">locked</span>}
                  </button>
                  {/* Buttons, not drag handles. The keyboard path and the
                      testable path are the same path. */}
                  <button
                    type="button"
                    aria-label={`Move ${BLOCK_LABELS[block.type]} up`}
                    disabled={index === 0}
                    className="h-9 w-9 grid place-items-center rounded surface-panel border border-surface-border disabled:opacity-30"
                    onClick={() => setBody(moveBlock(doc.body, index, index - 1))}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${BLOCK_LABELS[block.type]} down`}
                    disabled={index === doc.body.length - 1}
                    className="h-9 w-9 grid place-items-center rounded surface-panel border border-surface-border disabled:opacity-30"
                    onClick={() => setBody(moveBlock(doc.body, index, index + 1))}
                  >
                    <ArrowDown className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Duplicate ${BLOCK_LABELS[block.type]}`}
                    className="h-9 w-9 grid place-items-center rounded surface-panel border border-surface-border"
                    onClick={() => setBody(duplicateBlock(doc.body, block.id))}
                  >
                    <Copy className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${BLOCK_LABELS[block.type]}`}
                    disabled={Boolean(block.locked)}
                    className="h-9 w-9 grid place-items-center rounded surface-panel border border-surface-border disabled:opacity-30"
                    onClick={() => setBody(removeBlock(doc.body, block.id))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ol>

        {(errors.length > 0 || warnings.length > 0) && (
          <div className="mt-4 rounded-[--radius-card] bg-surface-card border-surface-border border p-3" data-testid="validation-tray">
            <p className="text-sm font-medium text-text-heading">
              {errors.length} problem{errors.length === 1 ? '' : 's'} · {warnings.length} warning
              {warnings.length === 1 ? '' : 's'}
            </p>
            <ul className="mt-2 space-y-1 text-sm">
              {[...errors, ...warnings].map((issue, i) => (
                <li key={i} className={issue.level === 'error' ? 'text-red-700' : 'text-amber-700'}>
                  {issue.message}
                  {issue.detail ? ` ${issue.detail}` : ''}
                </li>
              ))}
            </ul>
          </div>
        )}

        {changes.blocks.length > 0 && (
          <p className="mt-3 text-xs text-text-muted" data-testid="change-count">
            {changes.blocks.length} change{changes.blocks.length === 1 ? '' : 's'} since the
            published version.
          </p>
        )}

        {previewHtml && (
          <section className="mt-4">
            <h2 className="text-sm font-medium text-text-heading mb-2">Preview (sample data)</h2>
            {/* Sandboxed: the preview renders admin-authored markup, and it must
                not be able to script the page around it. */}
            <iframe
              title="Document preview"
              sandbox=""
              srcDoc={previewHtml}
              className="w-full h-[600px] rounded-[--radius-card] border-surface-border border bg-white"
            />
          </section>
        )}
      </main>

      {/* ── Inspector ───────────────────────────────────────────────────── */}
      <aside className="lg:w-80 shrink-0 space-y-3">
        {/* Page & letterhead. Above the block inspector because it applies to
            the whole document, and because this is the question people arrive
            with — "where do I put my letter pad?" */}
        <section
          className="rounded-[--radius-card] bg-surface-card border-surface-border border p-4 space-y-3"
          data-testid="page-setup-panel"
        >
          <h2 className="text-sm font-medium text-text-heading">Page &amp; letterhead</h2>
          <label className="block space-y-1 text-sm">
            <span className="text-xs text-text-muted">Letter pad behind this document</span>
            <select
              aria-label="Letterhead"
              data-testid="letterhead-select"
              className="w-full h-10 px-2 rounded-[--radius-input] surface-panel border-surface-border border"
              value={letterheadId ?? ''}
              onChange={(e) => {
                setLetterheadId(e.target.value || null);
                setSaveState('idle');
              }}
            >
              <option value="">No letterhead — plain paper</option>
              {letterheads.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.widthPx}×{a.heightPx})
                </option>
              ))}
            </select>
          </label>
          {letterheads.length === 0 ? (
            <p className="text-xs text-text-muted">
              No letter pad uploaded yet.{' '}
              <a className="underline" href="/dashboard/settings/documents/letterhead">
                Upload one
              </a>{' '}
              and it will appear here.
            </p>
          ) : (
            <a
              className="text-xs underline text-text-muted"
              href="/dashboard/settings/documents/letterhead"
            >
              Manage letter pads
            </a>
          )}
        </section>

        <div className="rounded-[--radius-card] bg-surface-card border-surface-border border">
        <BlockInspector
          block={selected}
          manifest={manifest}
          onChange={(next) => setBody(replaceBlock(doc.body, next.id, next))}
        />
        </div>
      </aside>
    </div>
  );
}

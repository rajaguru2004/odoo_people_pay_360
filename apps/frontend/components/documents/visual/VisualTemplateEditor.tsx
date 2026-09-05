'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import grapesjs, { Editor } from 'grapesjs';
import 'grapesjs/dist/css/grapes.min.css';
import { AtSign, Eye, Loader2 } from 'lucide-react';
import documentTemplateService from '@/services/documentTemplateService';
import { getApiErrorMessage } from '@/lib/apiError';
import {
  DocumentAssetSummary,
  GrapesTemplateDoc,
  TokenManifest,
  ValidationIssue,
} from '@/types/document-template';
import {
  buildCanvasFrameCss,
  buildEditorConfig,
  pageDimensionsMm,
} from '@/lib/document-template/grapes/editor-config';
import { buildBlockDefs } from '@/lib/document-template/grapes/blocks';
import {
  registerEssBlocks,
  registerEssComponents,
} from '@/lib/document-template/grapes/components';
import { buildChipHtml, CHIP_CANVAS_CSS } from '@/lib/document-template/grapes/chips';
import { validateGrapesHtml } from '@/lib/document-template/grapes/validate-grapes';
import { canPublish } from '@/lib/document-template/validate';
import { diffTokenUsage } from '@/lib/document-template/grapes/summary';
import VariableMentionPopover, {
  MentionOption,
} from './VariableMentionPopover';

/**
 * The GrapesJS visual editor — the ONLY file that imports grapesjs.
 *
 * Everything decidable is decided in the pure `lib/document-template/grapes/*`
 * modules; this file is wiring. GrapesJS cannot run in jsdom, so the component
 * tests mock this module's default export and the wiring is covered by the
 * Playwright journey instead.
 */

interface MentionState {
  anchor: { top: number; left: number };
  query: string;
  range: Range;
  preferCollection: string | null;
  /** Toolbar-opened: no caret feeds `query`, so the popover owns a search box. */
  searchable?: boolean;
}

export interface VisualTemplateEditorProps {
  versionId: string;
  initialDoc: GrapesTemplateDoc;
  initialUpdatedAt: string;
  manifest: TokenManifest | null;
  canPublishTemplate: boolean;
  publishedHtml: string | null;
  initialLetterheadId?: string | null;
  onPublished?: () => void;
  /** Called after the draft is deleted — the conversion's promised way back
   *  to the classic builder (history is append-only; published is untouched). */
  onDiscarded?: () => void;
}

export default function VisualTemplateEditor({
  versionId,
  initialDoc,
  initialUpdatedAt,
  manifest,
  canPublishTemplate,
  publishedHtml,
  initialLetterheadId = null,
  onPublished,
  onDiscarded,
}: VisualTemplateEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const updatedAtRef = useRef(initialUpdatedAt);
  const docRef = useRef(initialDoc);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saved' | 'error' | 'dirty'>('saved');
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [mention, setMention] = useState<MentionState | null>(null);
  const [letterheads, setLetterheads] = useState<DocumentAssetSummary[]>([]);
  const [letterheadId, setLetterheadId] = useState<string | null>(initialLetterheadId);
  const letterheadUrlRef = useRef<string | null>(null);

  /** Current doc snapshot from the live editor. */
  const snapshot = useCallback((): GrapesTemplateDoc => {
    const editor = editorRef.current;
    if (!editor) return docRef.current;
    return {
      ...docRef.current,
      grapes: {
        project: editor.getProjectData(),
        html: editor.getHtml(),
        css: editor.getCss() ?? '',
      },
    };
  }, []);

  const revalidate = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    setIssues(validateGrapesHtml(editor.getHtml(), manifest));
  }, [manifest]);

  // ── Canvas frame styling: sheet, guides, letterhead ghost, chips ─────────
  const applyFrameCss = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor) return;
    const frameDoc = editor.Canvas.getDocument();
    if (!frameDoc) return;

    const dims = pageDimensionsMm({
      pageSize: docRef.current.page.size,
      orientation: docRef.current.page.orientation,
    });
    const selected = letterheads.find((a) => a.id === letterheadId);
    const safe = selected
      ? {
          top: selected.safeTopMm,
          right: selected.safeRightMm,
          bottom: selected.safeBottomMm,
          left: selected.safeLeftMm,
        }
      : docRef.current.page.margin;

    let letterheadDataUrl: string | null = null;
    if (letterheadId) {
      try {
        // Authenticated blob → object URL. Canvas CSS is NOT exported, so the
        // ghost can never leak into stored HTML; the real artwork is
        // composited by the renderer.
        if (!letterheadUrlRef.current) {
          letterheadUrlRef.current = await documentTemplateService.assetPreviewUrl(letterheadId);
        }
        letterheadDataUrl = letterheadUrlRef.current;
      } catch {
        letterheadDataUrl = null;
      }
    }

    const styleId = 'ess-frame-style';
    let styleEl = frameDoc.getElementById(styleId) as HTMLStyleElement | null;
    if (!styleEl) {
      styleEl = frameDoc.createElement('style');
      styleEl.id = styleId;
      frameDoc.head.appendChild(styleEl);
    }
    styleEl.textContent = buildCanvasFrameCss({
      widthMm: dims.widthMm,
      heightMm: dims.heightMm,
      safe,
      letterheadDataUrl,
      dir: docRef.current.dir,
      chipCss: CHIP_CANVAS_CSS,
    });
    frameDoc.body.setAttribute('dir', docRef.current.dir);
  }, [letterheadId, letterheads]);

  // ── @-mention wiring ─────────────────────────────────────────────────────
  const closeMention = useCallback(() => setMention(null), []);

  const insertChip = useCallback(
    (option: MentionOption) => {
      const editor = editorRef.current;
      const state = mention;
      setMention(null);
      if (!editor || !state) return;
      const frameDoc = editor.Canvas.getDocument();
      const sel = frameDoc?.getSelection();
      const chipHtml = buildChipHtml(option) + '&nbsp;';

      // Typed-@ path: a live caret range inside the canvas — replace the
      // "@query" trigger text with the chip.
      const range = state.range;
      const rangeIsLive =
        frameDoc && range.startContainer && frameDoc.contains(range.startContainer);
      if (frameDoc && sel && rangeIsLive) {
        try {
          const chars = state.query.length + 1; // +1 for the '@'
          const start = range.startOffset - chars;
          if (start >= 0 && range.startContainer.nodeType === Node.TEXT_NODE) {
            range.setStart(range.startContainer, start);
          }
        } catch {
          // A moved caret must not break insertion — insert at the range as-is.
        }
        // Focus FIRST, then set the selection: focus() restores the element's
        // previous caret, so calling it after addRange silently clobbered the
        // extended range — the chip landed but the typed "@query" stayed.
        const host = (range.startContainer.parentElement ?? null)?.closest(
          '[contenteditable]',
        ) as HTMLElement | null;
        host?.focus();
        sel.removeAllRanges();
        sel.addRange(range);
        let inserted = false;
        try {
          inserted = frameDoc.execCommand('insertHTML', false, chipHtml);
        } catch {
          inserted = false;
        }
        if (!inserted) {
          // Unfocused/refused execCommand: do the same edit by hand so the
          // typed "@query" is still consumed and the chip still lands.
          range.deleteContents();
          const holder = frameDoc.createElement('span');
          holder.innerHTML = chipHtml;
          const nodes = Array.from(holder.childNodes);
          for (const node of nodes.reverse()) range.insertNode(node);
        }
      } else {
        // Toolbar path (no caret): append as a paragraph so the field lands
        // somewhere visible rather than being silently dropped.
        editor.addComponents(`<p>${chipHtml}</p>`);
      }
      setSaveState('dirty');
      revalidate();
    },
    [mention, revalidate],
  );

  const attachRteListeners = useCallback(
    (editor: Editor) => {
      let query = '';
      let active = false;

      const onInput = () => {
        const frameDoc = editor.Canvas.getDocument();
        const sel = frameDoc?.getSelection();
        if (!frameDoc || !sel || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);
        const node = range.startContainer;
        if (node.nodeType !== Node.TEXT_NODE) {
          if (active) closeMention();
          active = false;
          return;
        }
        const text = (node.textContent ?? '').slice(0, range.startOffset);
        const match = /(^|[\s(>])@([\w .-]*)$/.exec(text);
        if (!match) {
          if (active) closeMention();
          active = false;
          return;
        }
        query = match[2];
        active = true;

        const rect = range.getBoundingClientRect();
        const frameRect = editor.Canvas.getFrameEl()?.getBoundingClientRect();
        const container = containerRef.current?.getBoundingClientRect();
        const top = rect.bottom + (frameRect?.top ?? 0) - (container?.top ?? 0) + 6;
        const left = rect.left + (frameRect?.left ?? 0) - (container?.left ?? 0);

        // Which repeating table (if any) the caret sits in decides whether the
        // popover promotes that collection's fields as relative chips.
        const host = node.parentElement?.closest?.('[data-each]') ?? null;
        const preferCollection = host?.getAttribute('data-each') ?? null;

        setMention({
          anchor: { top, left },
          query,
          range: range.cloneRange(),
          preferCollection,
        });
      };

      editor.on('rte:enable', () => {
        const frameDoc = editor.Canvas.getDocument();
        frameDoc?.addEventListener('input', onInput);
      });
      editor.on('rte:disable', () => {
        const frameDoc = editor.Canvas.getDocument();
        frameDoc?.removeEventListener('input', onInput);
        closeMention();
        setSaveState('dirty');
        revalidate();
      });
    },
    [closeMention, revalidate],
  );

  // ── Save / preview / publish ─────────────────────────────────────────────
  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const doc = snapshot();
      const saved = await documentTemplateService.saveDraft(versionId, {
        doc,
        expectedUpdatedAt: updatedAtRef.current,
        letterheadId,
      });
      updatedAtRef.current = saved.updatedAt;
      setSaveState('saved');
      if (saved.removed?.length) {
        setError(
          `Some content was removed for safety: ${saved.removed.join(', ')}. The rest of your design was kept.`,
        );
      }
    } catch (err) {
      setSaveState('error');
      setError(getApiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }, [snapshot, versionId, letterheadId]);

  const preview = useCallback(async () => {
    setPreviewing(true);
    setError(null);
    try {
      const doc = snapshot();
      const res = await documentTemplateService.previewHtml({
        doc,
        typeKey: doc.documentType,
        letterheadId: letterheadId ?? undefined,
      });
      setPreviewHtml(res.html);
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      setPreviewing(false);
    }
  }, [snapshot, letterheadId]);

  const publish = useCallback(async () => {
    setPublishing(true);
    setError(null);
    try {
      const doc = snapshot();
      const saved = await documentTemplateService.saveDraft(versionId, {
        doc,
        expectedUpdatedAt: updatedAtRef.current,
        letterheadId,
      });
      await documentTemplateService.publish(versionId, saved.contentHash);
      onPublished?.();
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      setPublishing(false);
    }
  }, [snapshot, versionId, letterheadId, onPublished]);

  // ── Editor lifecycle ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const editor = grapesjs.init(
      buildEditorConfig({
        containerId: containerRef.current.id,
        pageSize: docRef.current.page.size,
        orientation: docRef.current.page.orientation,
        dir: docRef.current.dir,
      }) as Parameters<typeof grapesjs.init>[0],
    );
    editorRef.current = editor;

    registerEssComponents(editor);
    registerEssBlocks(editor, buildBlockDefs(manifest));

    editor.on('canvas:frame:load', () => void applyFrameCss());
    editor.on('component:add component:remove component:update', () => {
      setSaveState('dirty');
    });
    attachRteListeners(editor);

    const project = docRef.current.grapes.project;
    if (project && Object.keys(project as object).length > 0) {
      editor.loadProjectData(project as never);
    } else if (docRef.current.grapes.html) {
      editor.setComponents(docRef.current.grapes.html);
      if (docRef.current.grapes.css) editor.setStyle(docRef.current.grapes.css);
    }
    setReady(true);
    setIssues(validateGrapesHtml(editor.getHtml(), manifest));

    return () => {
      // Leaked listeners on navigation are exactly what the Playwright
      // problems fixture would catch as console noise.
      editor.destroy();
      editorRef.current = null;
      if (letterheadUrlRef.current) {
        const url = letterheadUrlRef.current;
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Letterhead list + reapply ghost on change.
  useEffect(() => {
    documentTemplateService
      .listAssets('LETTERHEAD')
      .then((list) => setLetterheads(list.filter((a) => a.isActive)))
      .catch(() => setLetterheads([]));
  }, []);
  useEffect(() => {
    letterheadUrlRef.current = null;
    if (ready) void applyFrameCss();
  }, [letterheadId, ready, applyFrameCss]);

  // Autosave: safe because a draft generates nothing.
  useEffect(() => {
    if (saveState !== 'dirty') return;
    const t = setTimeout(() => void save(), 2000);
    return () => clearTimeout(t);
  }, [saveState, save]);

  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warning');
  const publishable = canPublish(issues);
  const changes = useMemo(
    () =>
      publishedHtml !== null && editorRef.current
        ? diffTokenUsage(publishedHtml, editorRef.current.getHtml())
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [publishedHtml, saveState],
  );

  return (
    <div className="relative" data-testid="visual-template-editor">
      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button
          type="button"
          className="h-10 px-3 rounded-[--radius-button] bg-surface-card border-surface-border border text-sm"
          data-testid="insert-field-button"
          onClick={() => {
            // The discoverable (and Playwright-deterministic) path to the same
            // popover the typed-@ trigger opens.
            const rect = containerRef.current?.getBoundingClientRect();
            setMention({
              anchor: { top: 48, left: rect ? rect.width / 2 - 140 : 200 },
              query: '',
              range: new Range(),
              preferCollection: null,
              searchable: true,
            });
          }}
        >
          <AtSign className="inline h-4 w-4 me-1" />
          Insert field
        </button>
        <button
          type="button"
          onClick={() => void preview()}
          className="h-10 px-3 rounded-[--radius-button] bg-surface-card border-surface-border border text-sm"
        >
          {previewing ? (
            <Loader2 className="inline h-4 w-4 me-1 animate-spin" />
          ) : (
            <Eye className="inline h-4 w-4 me-1" />
          )}
          Preview
        </button>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-xs text-text-muted">Letter pad</span>
          <select
            aria-label="Letterhead"
            data-testid="letterhead-select"
            className="h-10 px-2 rounded-[--radius-input] bg-surface-card border-surface-border border"
            value={letterheadId ?? ''}
            onChange={(e) => {
              setLetterheadId(e.target.value || null);
              setSaveState('dirty');
            }}
          >
            <option value="">No letterhead</option>
            {letterheads.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <span className="text-xs text-text-muted" data-testid="save-state">
          {saving
            ? 'Saving…'
            : saveState === 'saved'
              ? 'Saved'
              : saveState === 'error'
                ? 'Save failed'
                : 'Unsaved changes'}
        </span>
        <div className="ms-auto flex items-center gap-2">
          <button
            type="button"
            data-testid="discard-draft"
            onClick={() => {
              // The promised way back: deleting the draft returns the template
              // to its published version — and, for a converted draft, to the
              // classic builder on the next edit. Nothing published is touched.
              if (!window.confirm('Discard this draft? The published version stays as it is.')) {
                return;
              }
              setDiscarding(true);
              setError(null);
              documentTemplateService
                .discardDraft(versionId)
                .then(() => onDiscarded?.())
                .catch((err) => setError(getApiErrorMessage(err)))
                .finally(() => setDiscarding(false));
            }}
            disabled={discarding}
            className="h-10 px-3 rounded-[--radius-button] bg-surface-card border-surface-border border text-sm text-red-700 disabled:opacity-50"
          >
            {discarding ? 'Discarding…' : 'Discard draft'}
          </button>
          {canPublishTemplate && (
            <button
              type="button"
              data-testid="publish-button"
              onClick={() => void publish()}
              disabled={!publishable || publishing || !ready}
              title={publishable ? undefined : 'Fix the problems listed below before publishing.'}
              className="h-10 px-4 rounded-[--radius-button] bg-brand-primary text-text-on-brand text-sm disabled:opacity-40"
            >
              {publishing ? 'Publishing…' : 'Publish'}
            </button>
          )}
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="mb-3 rounded-[--radius-card] border border-red-200 bg-red-50 p-3 text-sm text-red-800"
        >
          {error}
        </div>
      )}

      {/* ── Editor shell: blocks | canvas ───────────────────────────────── */}
      <div className="flex gap-3">
        <div className="w-48 shrink-0 rounded-[--radius-card] bg-surface-card border-surface-border border p-2 text-sm" data-testid="visual-blocks-panel">
          {/* GrapesJS renders its BlockManager here via appendTo? No — blocks
              are click-to-add through our own list for determinism. */}
          <p className="text-xs uppercase tracking-wide text-text-muted mb-2 px-1">Add a block</p>
          {buildBlockDefs(manifest).map((b) => (
            <button
              key={b.id}
              type="button"
              className="w-full text-start h-9 px-2 rounded-[--radius-button] hover:bg-brand-primary/5"
              data-testid={`visual-block-${b.id}`}
              onClick={() => {
                const editor = editorRef.current;
                if (!editor) return;
                editor.addComponents(b.content);
                setSaveState('dirty');
                revalidate();
              }}
            >
              {b.label}
            </button>
          ))}
        </div>
        <div className="flex-1 min-w-0 rounded-[--radius-card] border-surface-border border overflow-hidden bg-slate-100">
          <div id="visual-editor-canvas" ref={containerRef} style={{ height: '75vh' }} />
        </div>
      </div>

      {/* ── Validation tray ─────────────────────────────────────────────── */}
      {(errors.length > 0 || warnings.length > 0) && (
        <div
          className="mt-3 rounded-[--radius-card] bg-surface-card border-surface-border border p-3"
          data-testid="validation-tray"
        >
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

      {/* ── Field-usage summary (replaces the block diff for grapes drafts) ─ */}
      {changes &&
        (changes.addedFields.length > 0 || changes.removedFields.length > 0) && (
          <p className="mt-2 text-xs text-text-muted" data-testid="field-usage-summary">
            {changes.addedFields.length > 0 && `Fields added: ${changes.addedFields.join(', ')}. `}
            {changes.removedFields.length > 0 && `Fields removed: ${changes.removedFields.join(', ')}.`}
          </p>
        )}

      {previewHtml && (
        <section className="mt-4">
          <h2 className="text-sm font-medium text-text-heading mb-2">Preview (sample data)</h2>
          <iframe
            title="Document preview"
            sandbox=""
            srcDoc={previewHtml}
            className="w-full h-[600px] rounded-[--radius-card] border-surface-border border bg-white"
          />
        </section>
      )}

      {mention && (
        <VariableMentionPopover
          manifest={manifest}
          anchor={mention.anchor}
          query={mention.query}
          preferCollection={mention.preferCollection}
          searchable={mention.searchable}
          onSelect={insertChip}
          onClose={closeMention}
        />
      )}
    </div>
  );
}

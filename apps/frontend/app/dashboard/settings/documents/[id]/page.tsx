'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import dynamic from 'next/dynamic';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import TemplateBuilder from '@/components/documents/TemplateBuilder';
import { useBrandingStore } from '@/store/brandingStore';

// GrapesJS (~900KB min) must stay out of the shared bundle: it loads only when
// a grapes-kind draft is actually opened, and never on the server (no DOM).
const VisualTemplateEditor = dynamic(
  () => import('@/components/documents/visual/VisualTemplateEditor'),
  { ssr: false, loading: () => <p className="p-6 text-sm text-text-muted">Loading visual editor…</p> },
);
import documentTemplateService from '@/services/documentTemplateService';
import { getApiErrorMessage } from '@/lib/apiError';
import { parseDoc } from '@/lib/document-template/blocks';
import { hasPermission } from '@/utils/permissions';
import { useAuthStore } from '@/store/authStore';
import {
  DocumentTemplateDetail,
  DocumentTemplateDoc,
  GrapesTemplateDoc,
  isGrapesDoc,
  TokenManifest,
} from '@/types/document-template';

function TemplateEditor() {
  const params = useParams<{ id: string }>();
  const id = params?.id as string;
  const user = useAuthStore((s) => s.user);

  const [template, setTemplate] = useState<DocumentTemplateDetail | null>(null);
  const [manifest, setManifest] = useState<TokenManifest | null>(null);
  const [draftDoc, setDraftDoc] = useState<DocumentTemplateDoc | null>(null);
  const [grapesDoc, setGrapesDoc] = useState<GrapesTemplateDoc | null>(null);
  const [converting, setConverting] = useState(false);
  const [draftVersionId, setDraftVersionId] = useState<string | null>(null);
  const [draftUpdatedAt, setDraftUpdatedAt] = useState<string>('');
  const [draftLetterheadId, setDraftLetterheadId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const detail = await documentTemplateService.get(id);
      setTemplate(detail);
      const m = await documentTemplateService.manifest(detail.typeKey).catch(() => null);
      setManifest(m);

      if (detail.draft?.doc) {
        // The DRAFT decides which editor opens, so one template's history can
        // hold both dialects.
        if (isGrapesDoc(detail.draft.doc)) {
          setGrapesDoc(detail.draft.doc);
          setDraftDoc(null);
        } else {
          setDraftDoc(parseDoc(detail.draft.doc));
          setGrapesDoc(null);
        }
        setDraftVersionId(detail.draft.id);
        setDraftUpdatedAt(detail.draft.updatedAt);
        setDraftLetterheadId(detail.draft.letterheadId ?? null);
      } else {
        setDraftDoc(null);
        setGrapesDoc(null);
        setDraftVersionId(null);
      }
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (id) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const startDraft = async () => {
    setError(null);
    try {
      const draft = await documentTemplateService.createDraft(id);
      await load();
      setDraftVersionId(draft.id);
    } catch (err) {
      setError(getApiErrorMessage(err));
    }
  };

  const visualEnabled = useBrandingStore((s) => s.branding.document_visual_editor_enabled);

  const convertToVisual = async () => {
    if (!draftVersionId) return;
    setConverting(true);
    setError(null);
    try {
      const seed = await documentTemplateService.visualSeed(draftVersionId);
      // Consent BEFORE the one-way conversion: what has no visual equivalent
      // is named, not silently dropped. window.confirm keeps this dependency-
      // free; the list is short by construction.
      const droppedNote = seed.dropped.length
        ? `\n\nSwitching removes (cannot be undone for this draft):\n• ${seed.dropped.join('\n• ')}`
        : '';
      const ok = window.confirm(
        `Open this draft in the visual editor?${droppedNote}\n\nDiscarding the draft later returns to the classic builder.`,
      );
      if (!ok) return;
      await documentTemplateService.saveDraft(draftVersionId, {
        doc: seed.doc,
        expectedUpdatedAt: draftUpdatedAt,
        letterheadId: draftLetterheadId,
      });
      await load();
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      setConverting(false);
    }
  };

  // A missing role means the session has not resolved yet. Treated as "no",
  // which is the safe reading and matches ProtectedRoute's own three-state
  // handling — a control that flashes enabled and then disables is worse than
  // one that appears a moment late.
  const canManage = Boolean(user?.role && hasPermission(user.role, 'MANAGE_DOCUMENT_TEMPLATES'));
  const canPublishTemplate = Boolean(
    user?.role && hasPermission(user.role, 'PUBLISH_DOCUMENT_TEMPLATE'),
  );

  if (loading) {
    return <div className="p-6 text-sm text-text-muted">Loading template…</div>;
  }

  if (error && !template) {
    return (
      <div className="p-6">
        <div role="alert" className="rounded-[--radius-card] border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-4" data-testid="document-template-editor">
      <div className="flex items-center gap-2">
        <Link
          href="/dashboard/settings/documents"
          className="h-10 px-3 grid place-items-center rounded-[--radius-button] surface-panel border-surface-border border text-sm"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-text-heading truncate">{template?.name}</h1>
          <p className="text-xs text-text-muted">
            {template?.typeName} · {template?.locale} ·{' '}
            {template?.scope === 'COMPANY' ? 'Company-wide' : `Branch: ${template?.branchName ?? '—'}`}
          </p>
        </div>
      </div>

      {error && (
        <div role="alert" className="rounded-[--radius-card] border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {/* The builder is desktop-only, and the product says so at the door
          rather than shipping three panes onto a phone. */}
      <p className="md:hidden rounded-[--radius-card] bg-surface-card border-surface-border border p-4 text-sm">
        <strong>Template design needs a bigger screen.</strong> Open this on a laptop to edit the
        layout.
      </p>

      <div className="hidden md:block">
        {!draftDoc && !grapesDoc && (
          <div className="rounded-[--radius-card] bg-surface-card border-surface-border border p-6 text-center space-y-3">
            <p className="text-sm text-text-body">
              This template is published and locked. Editing creates a new draft; the published
              version keeps generating documents until you publish the new one.
            </p>
            {canManage ? (
              <button
                type="button"
                onClick={() => void startDraft()}
                className="h-11 px-4 rounded-[--radius-button] bg-brand-primary text-text-on-brand text-sm"
                data-testid="start-draft"
              >
                Edit this template
              </button>
            ) : (
              <p className="text-xs text-text-muted">Your role can view templates but not edit them.</p>
            )}
          </div>
        )}

        {grapesDoc && draftVersionId && !visualEnabled && (
          // The kill switch must kill: with the flag off, an existing visual
          // draft may not quietly load GrapesJS anyway. The draft is offered
          // back to the classic flow instead of stranding the template.
          <div
            className="rounded-[--radius-card] bg-surface-card border-surface-border border p-6 text-center space-y-3"
            data-testid="visual-editor-disabled"
          >
            <p className="text-sm text-text-body">
              The visual editor is switched off on this deployment, and this draft was made with
              it. Discard the draft to go back to the classic builder — the published version is
              not affected.
            </p>
            {canManage && (
              <button
                type="button"
                data-testid="discard-visual-draft"
                onClick={() => {
                  if (!window.confirm('Discard this draft? The published version stays as it is.')) return;
                  void documentTemplateService
                    .discardDraft(draftVersionId)
                    .then(() => load())
                    .catch((err) => setError(getApiErrorMessage(err)));
                }}
                className="h-11 px-4 rounded-[--radius-button] bg-brand-primary text-text-on-brand text-sm"
              >
                Discard draft
              </button>
            )}
          </div>
        )}

        {grapesDoc && draftVersionId && visualEnabled && (
          <VisualTemplateEditor
            key={draftVersionId}
            versionId={draftVersionId}
            initialDoc={grapesDoc}
            initialUpdatedAt={draftUpdatedAt}
            manifest={manifest}
            canPublishTemplate={canPublishTemplate}
            publishedHtml={template?.published?.bodyHtml ?? null}
            initialLetterheadId={draftLetterheadId}
            onPublished={() => void load()}
            onDiscarded={() => void load()}
          />
        )}

        {draftDoc && draftVersionId && canManage && visualEnabled && (
          <div className="mb-3 rounded-[--radius-card] border border-brand-primary/30 bg-brand-primary/5 p-3 text-sm flex items-center justify-between gap-3">
            <span className="text-text-body">
              This draft uses the classic builder. The visual editor lets you design freely and
              insert fields by typing <strong>@</strong>.
            </span>
            <button
              type="button"
              data-testid="convert-to-visual"
              onClick={() => void convertToVisual()}
              disabled={converting}
              className="h-10 px-4 shrink-0 rounded-[--radius-button] bg-brand-primary text-text-on-brand disabled:opacity-50"
            >
              {converting ? 'Preparing…' : 'Open in visual editor'}
            </button>
          </div>
        )}

        {draftDoc && draftVersionId && (
          <TemplateBuilder
            versionId={draftVersionId}
            initialDoc={draftDoc}
            initialUpdatedAt={draftUpdatedAt}
            manifest={manifest}
            canPublishTemplate={canPublishTemplate}
            initialLetterheadId={draftLetterheadId}
            publishedDoc={
              template?.published?.doc ? parseDoc(template.published.doc) : null
            }
            onPublished={() => void load()}
          />
        )}
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <ProtectedRoute requiredPermission="VIEW_DOCUMENT_TEMPLATES">
      <TemplateEditor />
    </ProtectedRoute>
  );
}

'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { FileText, Image as ImageIcon, RefreshCw, Search } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import documentTemplateService from '@/services/documentTemplateService';
import {
  DocumentTemplateSummary,
  DocumentTypeSummary,
} from '@/types/document-template';
import { getApiErrorMessage } from '@/lib/apiError';

/**
 * The template gallery.
 *
 * One page rather than two tabs for "shipped" and "yours", because the empty
 * state of "your templates" is precisely "go pick one of the shipped ones" —
 * splitting them hides the answer behind a tab.
 */
function statusChip(t: DocumentTemplateSummary): { label: string; className: string } {
  if (t.hasDraft) {
    return {
      label: t.publishedVersionId ? `Published v${t.publishedVersionNo} · draft open` : 'Draft',
      className: 'bg-amber-100 text-amber-800',
    };
  }
  if (t.publishedVersionId) {
    return { label: `Published v${t.publishedVersionNo}`, className: 'bg-emerald-100 text-emerald-800' };
  }
  return { label: 'Not published', className: 'bg-slate-100 text-slate-600' };
}

function DocumentTemplatesGallery() {
  const [templates, setTemplates] = useState<DocumentTemplateSummary[]>([]);
  const [types, setTypes] = useState<DocumentTypeSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('ALL');

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, catalogue] = await Promise.all([
        documentTemplateService.list(),
        documentTemplateService.types(),
      ]);
      setTemplates(list);
      setTypes(catalogue);
    } catch (err) {
      // Read through the shared helper: axios rejects with a FLAT object here,
      // so `err.response.data.message` is undefined and the user would be told
      // "the operation could not be completed".
      setError(getApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const categoryOf = useMemo(() => {
    const map = new Map(types.map((t) => [t.key, t.category]));
    return (typeKey: string) => map.get(typeKey) ?? 'OTHER';
  }, [types]);

  const categories = useMemo(
    () => ['ALL', ...Array.from(new Set(types.map((t) => t.category))).sort()],
    [types],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return templates.filter((t) => {
      if (category !== 'ALL' && categoryOf(t.typeKey) !== category) return false;
      if (!q) return true;
      return (
        t.name.toLowerCase().includes(q) ||
        t.typeName.toLowerCase().includes(q) ||
        t.typeKey.toLowerCase().includes(q)
      );
    });
  }, [templates, query, category, categoryOf]);

  return (
    <div className="p-4 md:p-6 space-y-5" data-testid="document-templates-gallery">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-text-heading">Document templates</h1>
        <p className="text-sm text-text-muted">
          Design the letters, payslips and certificates your company issues. Changes take effect
          when you publish; documents already issued keep the wording they were made with.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-muted" />
          <input
            aria-label="Search templates"
            className="w-full h-11 pl-9 pr-3 rounded-[--radius-input] surface-panel border-surface-border border text-sm"
            placeholder="Search templates…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <select
          aria-label="Filter by category"
          className="h-11 px-3 rounded-[--radius-input] surface-panel border-surface-border border text-sm"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          {categories.map((c) => (
            <option key={c} value={c}>
              {c === 'ALL' ? 'All categories' : c}
            </option>
          ))}
        </select>
        <Link
          href="/dashboard/settings/documents/letterhead"
          className="h-11 px-4 inline-flex items-center gap-2 rounded-[--radius-button] surface-panel border-surface-border border text-sm"
        >
          <ImageIcon className="h-4 w-4" />
          Letterhead
        </Link>
        <button
          type="button"
          onClick={() => void load()}
          className="h-11 w-11 grid place-items-center rounded-[--radius-button] surface-panel border-surface-border border"
          aria-label="Refresh"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      {error && (
        <div role="alert" className="rounded-[--radius-card] border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {error}
        </div>
      )}

      {loading && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-32 rounded-[--radius-card] bg-surface-card animate-pulse" />
          ))}
        </div>
      )}

      {!loading && !error && visible.length === 0 && (
        <div className="rounded-[--radius-card] bg-surface-card border-surface-border border p-8 text-center">
          <FileText className="mx-auto h-8 w-8 text-text-muted" />
          <p className="mt-2 text-sm text-text-body">
            {templates.length === 0
              ? 'No templates yet. They are created automatically the first time the engine starts.'
              : 'No template matches that search.'}
          </p>
        </div>
      )}

      {!loading && visible.length > 0 && (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((t) => {
            const chip = statusChip(t);
            return (
              <li key={t.id}>
                <Link
                  href={`/dashboard/settings/documents/${t.id}`}
                  className="block h-full rounded-[--radius-card] bg-surface-card border-surface-border border p-4 hover:shadow-sm transition"
                  data-testid={`template-card-${t.typeKey}-${t.locale}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium text-text-heading truncate">{t.name}</p>
                      <p className="text-xs text-text-muted truncate">{t.typeName}</p>
                    </div>
                    <span className="text-[11px] uppercase tracking-wide rounded px-1.5 py-0.5 surface-panel border border-surface-border">
                      {t.locale}
                    </span>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <span className={`text-xs rounded px-2 py-0.5 ${chip.className}`}>{chip.label}</span>
                    <span className="text-xs text-text-muted">
                      {/* Which one WINS for a branch is not obvious from a list, so
                          the scope is always on the card rather than in a tooltip. */}
                      {t.scope === 'COMPANY' ? 'Company-wide' : `Branch: ${t.branchName ?? '—'}`}
                    </span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default function Page() {
  return (
    <ProtectedRoute requiredPermission="VIEW_DOCUMENT_TEMPLATES">
      <DocumentTemplatesGallery />
    </ProtectedRoute>
  );
}

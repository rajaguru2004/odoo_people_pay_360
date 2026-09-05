'use client';

import { Block, TokenManifest } from '@/types/document-template';

/**
 * The properties panel for the selected block.
 *
 * Constraints beat freedom here, deliberately. There is no free positioning,
 * no arbitrary colour and no font size outside 8–24pt — a non-technical user
 * cannot produce a layout that will not print, and every control maps to
 * something the compiler actually emits.
 */
export default function BlockInspector({
  block,
  manifest,
  onChange,
}: {
  block: Block | null;
  manifest: TokenManifest | null;
  onChange: (next: Block) => void;
}) {
  if (!block) {
    return (
      <p className="text-sm text-text-muted p-4" data-testid="inspector-empty">
        Select a block to edit it.
      </p>
    );
  }

  const set = (props: Record<string, unknown>) =>
    onChange({ ...block, props: { ...(block.props as object), ...props } } as Block);

  const collections = manifest?.collections ?? [];

  return (
    <div className="p-4 space-y-4 text-sm" data-testid="block-inspector">
      <div>
        <p className="font-medium text-text-heading capitalize">{block.type}</p>
        {block.locked && (
          // Shown WITH its reason rather than hidden. A builder that silently
          // omits required blocks just produces a confusing failure later.
          <p className="text-xs text-amber-700 mt-1">
            This block is part of the shipped design and cannot be removed. You can still restyle it.
          </p>
        )}
      </div>

      {(block.type === 'text' || block.type === 'heading') && (
        <label className="block space-y-1">
          <span className="text-xs text-text-muted">Content</span>
          <textarea
            aria-label="Block content"
            className="w-full min-h-24 p-2 rounded-[--radius-input] surface-panel border-surface-border border font-mono text-xs"
            value={String((block.props as { html?: string }).html ?? '')}
            onChange={(e) => set({ html: e.target.value })}
          />
          <span className="text-xs text-text-muted">
            Insert a field by typing it in double braces, e.g. {'{{employeeName}}'}.
          </span>
        </label>
      )}

      {block.type === 'heading' && (
        <label className="block space-y-1">
          <span className="text-xs text-text-muted">Level</span>
          <select
            aria-label="Heading level"
            className="w-full h-10 px-2 rounded-[--radius-input] surface-panel border-surface-border border"
            value={block.props.level}
            onChange={(e) => set({ level: Number(e.target.value) })}
          >
            <option value={1}>Title</option>
            <option value={2}>Section</option>
            <option value={3}>Sub-section</option>
          </select>
        </label>
      )}

      {'align' in (block.props as object) && (
        <label className="block space-y-1">
          <span className="text-xs text-text-muted">Alignment</span>
          <select
            aria-label="Alignment"
            className="w-full h-10 px-2 rounded-[--radius-input] surface-panel border-surface-border border"
            value={String((block.props as { align?: string }).align ?? 'start')}
            onChange={(e) => set({ align: e.target.value })}
          >
            {/* Logical, not physical: a `left`-aligned block in an Arabic
                document is a bug you ship once. */}
            <option value="start">Start (left in English, right in Arabic)</option>
            <option value="center">Centre</option>
            <option value="end">End</option>
            <option value="justify">Justify</option>
          </select>
        </label>
      )}

      {block.type === 'spacer' && (
        <label className="block space-y-1">
          <span className="text-xs text-text-muted">Height (mm)</span>
          <input
            aria-label="Height in millimetres"
            type="number"
            min={1}
            max={100}
            className="w-full h-10 px-2 rounded-[--radius-input] surface-panel border-surface-border border"
            value={block.props.heightMm}
            onChange={(e) => set({ heightMm: Number(e.target.value) })}
          />
        </label>
      )}

      {block.type === 'dataTable' && (
        <>
          <label className="block space-y-1">
            <span className="text-xs text-text-muted">Repeat one row for each</span>
            <select
              aria-label="Table data"
              className="w-full h-10 px-2 rounded-[--radius-input] surface-panel border-surface-border border"
              value={block.props.bind}
              onChange={(e) => set({ bind: e.target.value, columns: [] })}
            >
              <option value="">Choose a list…</option>
              {collections.map((c) => (
                <option key={c.path} value={c.path}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          {block.props.bind && (
            <fieldset className="space-y-1">
              <legend className="text-xs text-text-muted">Columns</legend>
              {(collections.find((c) => c.path === block.props.bind)?.fields ?? []).map((f) => {
                const checked = block.props.columns.some((c) => c.key === f.name);
                return (
                  <label key={f.name} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) =>
                        set({
                          columns: e.target.checked
                            ? [
                                ...block.props.columns,
                                {
                                  key: f.name,
                                  header: f.label,
                                  align: f.type === 'money' ? 'end' : 'start',
                                  format: f.type === 'money' ? 'money' : 'none',
                                },
                              ]
                            : block.props.columns.filter((c) => c.key !== f.name),
                        })
                      }
                    />
                    <span>{f.label}</span>
                  </label>
                );
              })}
            </fieldset>
          )}
        </>
      )}

      {block.type === 'keyValue' && (
        <fieldset className="space-y-2">
          <legend className="text-xs text-text-muted">Rows</legend>
          {block.props.rows.map((row, i) => (
            <div key={i} className="flex gap-2">
              <input
                aria-label={`Row ${i + 1} label`}
                className="flex-1 h-10 px-2 rounded-[--radius-input] surface-panel border-surface-border border"
                value={row.label}
                onChange={(e) =>
                  set({
                    rows: block.props.rows.map((r, j) =>
                      j === i ? { ...r, label: e.target.value } : r,
                    ),
                  })
                }
              />
              <input
                aria-label={`Row ${i + 1} value`}
                className="flex-1 h-10 px-2 rounded-[--radius-input] surface-panel border-surface-border border font-mono text-xs"
                value={row.value}
                onChange={(e) =>
                  set({
                    rows: block.props.rows.map((r, j) =>
                      j === i ? { ...r, value: e.target.value } : r,
                    ),
                  })
                }
              />
            </div>
          ))}
          <button
            type="button"
            className="h-9 px-3 rounded-[--radius-button] surface-panel border-surface-border border text-xs"
            onClick={() => set({ rows: [...block.props.rows, { label: '', value: '' }] })}
          >
            Add row
          </button>
          <label className="flex items-center gap-2 pt-1">
            <input
              type="checkbox"
              checked={block.props.hideEmptyRows ?? false}
              onChange={(e) => set({ hideEmptyRows: e.target.checked })}
            />
            {/* An empty "Passport number:" reads as missing data rather than as
                not applicable, which is why this exists at all. */}
            <span className="text-xs">Hide a row when its value is blank</span>
          </label>
        </fieldset>
      )}

      <label className="block space-y-1">
        <span className="text-xs text-text-muted">Space after (mm)</span>
        <input
          aria-label="Space after in millimetres"
          type="number"
          min={0}
          max={60}
          className="w-full h-10 px-2 rounded-[--radius-input] surface-panel border-surface-border border"
          value={block.spacingAfterMm ?? 0}
          onChange={(e) => onChange({ ...block, spacingAfterMm: Number(e.target.value) })}
        />
      </label>
    </div>
  );
}

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { TokenDef, TokenManifest } from '@/types/document-template';
import { ChipSpec, formatForToken } from '@/lib/document-template/grapes/chips';

/**
 * The @-mention field picker.
 *
 * Pure React and GrapesJS-agnostic BY DESIGN: it receives an anchor rect and a
 * manifest, and reports a selection. That is what makes it testable in jsdom
 * while the editor itself (which cannot run in jsdom) is mocked.
 */
export interface MentionOption extends ChipSpec {
  group: string;
}

export function optionsFromManifest(
  manifest: TokenManifest | null,
  opts: { preferCollection?: string | null } = {},
): MentionOption[] {
  if (!manifest) return [];
  const out: MentionOption[] = [];

  // Inside a repeating table, that table's fields come FIRST and are inserted
  // as RELATIVE paths — Handlebars resolves them per row.
  if (opts.preferCollection) {
    const coll = manifest.collections.find((c) => c.path === opts.preferCollection);
    for (const f of coll?.fields ?? []) {
      out.push({
        path: f.name,
        label: f.label,
        format: formatForToken({ type: f.type }),
        group: `${coll!.label} (this table)`,
      });
    }
  }

  for (const group of manifest.groups) {
    for (const token of group.tokens) {
      if (token.type === 'table') continue; // tables are blocks, not chips
      out.push({
        path: token.path,
        label: token.label,
        format: formatForToken(token as TokenDef),
        group: group.group,
      });
    }
  }
  return out;
}

export default function VariableMentionPopover({
  manifest,
  anchor,
  query,
  preferCollection,
  searchable = false,
  onSelect,
  onClose,
}: {
  manifest: TokenManifest | null;
  /** Page-space rect of the caret or the triggering button. */
  anchor: { top: number; left: number };
  /** Live text typed after the `@`. */
  query: string;
  preferCollection?: string | null;
  /** Toolbar mode: there is no caret feeding `query`, so the popover owns a
   *  search box — without one, everything past the first 12 options (the
   *  employee fields, behind the company group) is simply unreachable. */
  searchable?: boolean;
  onSelect: (option: MentionOption) => void;
  onClose: () => void;
}) {
  const [active, setActive] = useState(0);
  const [ownQuery, setOwnQuery] = useState('');
  const listRef = useRef<HTMLUListElement>(null);

  const effectiveQuery = searchable ? ownQuery : query;

  const options = useMemo(() => {
    const all = optionsFromManifest(manifest, { preferCollection });
    const q = effectiveQuery.trim().toLowerCase();
    if (!q) return all.slice(0, 12);
    return all
      .filter(
        (o) => o.label.toLowerCase().includes(q) || o.path.toLowerCase().includes(q),
      )
      .slice(0, 12);
  }, [manifest, effectiveQuery, preferCollection]);

  useEffect(() => setActive(0), [effectiveQuery]);

  // Keyboard handling lives HERE (the popover owns focus semantics); the
  // editor forwards key events it captured in the canvas iframe.
  useEffect(() => {
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  // Exposed for the editor's captured keydown events.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, options.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (options[active]) onSelect(options[active]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [options, active, onSelect, onClose]);

  const searchBox = searchable ? (
    <input
      data-testid="mention-search"
      type="search"
      autoFocus
      value={ownQuery}
      onChange={(e) => setOwnQuery(e.target.value)}
      placeholder="Search fields…"
      aria-label="Search fields"
      className="w-full h-9 px-3 text-sm bg-surface-card border-b border-surface-border outline-none text-text-body"
    />
  ) : null;

  if (options.length === 0) {
    return (
      <div
        data-testid="mention-popover"
        className="fixed z-50 w-72 rounded-[--radius-card] bg-surface-card border border-surface-border shadow-lg text-sm text-text-muted"
        style={{ top: anchor.top, left: anchor.left }}
      >
        {searchBox}
        <p className="p-3">No field matches “{effectiveQuery}”.</p>
      </div>
    );
  }

  let lastGroup = '';
  return (
    <div
      data-testid="mention-popover"
      className="fixed z-50 w-72 max-h-80 overflow-auto rounded-[--radius-card] bg-surface-card border border-surface-border shadow-lg"
      style={{ top: anchor.top, left: anchor.left }}
      role="listbox"
      aria-label="Insert a field"
    >
      {searchBox}
      <ul ref={listRef}>
        {options.map((o, i) => {
          const showGroup = o.group !== lastGroup;
          lastGroup = o.group;
          return (
            <li key={`${o.group}:${o.path}`}>
              {showGroup && (
                <p className="px-3 pt-2 pb-1 text-[11px] uppercase tracking-wide text-text-muted">
                  {o.group}
                </p>
              )}
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                data-testid={`mention-option-${o.path}`}
                className={`w-full text-start px-3 py-2 text-sm ${
                  i === active ? 'bg-brand-primary/10 text-text-heading' : 'text-text-body'
                }`}
                onMouseEnter={() => setActive(i)}
                // Select on MOUSEDOWN, default prevented — not on click. A
                // click would first blur the canvas iframe, GrapesJS fires
                // rte:disable, closeMention() unmounts this button, and the
                // click lands on nothing: the option "worked" and inserted
                // nothing. Acting inside mousedown runs while the canvas
                // selection is still live; preventDefault keeps focus (and
                // the caret) where the chip must go.
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect(o);
                }}
              >
                <span className="font-medium">{o.label}</span>
                <span className="ms-2 text-xs text-text-muted">{o.path}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

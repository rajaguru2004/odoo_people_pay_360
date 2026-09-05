'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Building2, ChevronDown, ChevronRight, UsersRound } from 'lucide-react';
import { fullName } from '@/utils/formatters';
import type { DepartmentNode } from '@/types/department';

/**
 * The org chart is drawn ONE level open past where the reader is standing.
 *
 * Levels 0 and 1 arrive expanded so the shape of the company is visible without
 * a click, and everything below opens on demand — a fully expanded chart of a
 * real company is a wall the reader has to collapse before they can read it.
 */
const OPEN_THROUGH_LEVEL = 2;

/** Indentation per level, in pixels. Applied as a LOGICAL inset so RTL flips. */
const INDENT = 32;

export default function DepartmentTreeNode({
  node,
  level = 0,
}: {
  node: DepartmentNode;
  level?: number;
}) {
  const [expanded, setExpanded] = useState(level < OPEN_THROUGH_LEVEL);
  const children = node.children ?? [];
  const hasChildren = children.length > 0;

  return (
    <div className="relative">
      <div
        // Both attributes sit on the same element on purpose: a test that finds
        // the node and a test that reads its depth must not be able to
        // disagree about which box they are talking about.
        data-testid={`tree-node-${node.code}`}
        data-tree-level={level}
        style={{ marginInlineStart: level * INDENT }}
        className="mb-2 flex items-center gap-3 rounded-[var(--radius-card)] border border-surface-border bg-surface-card p-3 transition-colors hover:border-brand-primary/40"
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${node.name}`}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-button)] bg-brand-primary text-text-on-brand transition-colors hover:bg-brand-primary-dark"
          >
            {expanded ? (
              <ChevronDown className="h-4 w-4" aria-hidden />
            ) : (
              <ChevronRight className="h-4 w-4 rtl:rotate-180" aria-hidden />
            )}
          </button>
        ) : (
          <span
            aria-hidden
            className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-button)] bg-surface-border-light"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-text-muted" />
          </span>
        )}

        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[var(--radius-card)] bg-brand-primary/10 text-brand-primary">
          <Building2 className="h-5 w-5" aria-hidden />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Link
              href={`/dashboard/departments/${node.id}`}
              className="truncate text-sm font-semibold text-text-heading hover:text-brand-primary hover:underline"
            >
              {node.name}
            </Link>
            <span className="shrink-0 rounded-[var(--radius-badge)] bg-surface-border-light px-2 py-0.5 text-[11px] font-medium text-text-muted">
              {node.code}
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs text-text-muted">
            <span className="inline-flex items-center gap-1 tabular-nums">
              <UsersRound className="h-3.5 w-3.5" aria-hidden />
              {node.employees} {node.employees === 1 ? 'person' : 'people'}
            </span>
            {/* Named rather than "—": a unit with nobody in charge is the thing
                the whole Organisation module exists to make visible. */}
            <span>
              Head: {node.manager ? fullName(node.manager) : <span className="text-status-warning">nobody</span>}
            </span>
            {node.branch && <span>{node.branch.name}</span>}
          </div>
        </div>
      </div>

      {expanded &&
        children.map((child) => (
          <DepartmentTreeNode key={child.id} node={child} level={level + 1} />
        ))}
    </div>
  );
}

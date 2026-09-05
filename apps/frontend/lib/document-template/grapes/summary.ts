import { collectChipPaths, collectEachPaths } from './chips';

/**
 * What changed between two grapes drafts, for the publish dialog.
 *
 * A block-level diff is meaningless for freeform HTML, but the question the
 * publish dialog answers — "will this break?" — is mostly about FIELDS: which
 * data the document now pulls, which it stopped pulling. That is a set diff
 * over `data-var`/`data-each`, pure and node-testable.
 */
export interface TokenUsageDiff {
  addedFields: string[];
  removedFields: string[];
  addedTables: string[];
  removedTables: string[];
}

export function diffTokenUsage(oldHtml: string | null, newHtml: string): TokenUsageDiff {
  const oldFields = new Set(collectChipPaths(oldHtml ?? '').map((c) => c.path));
  const newFields = new Set(collectChipPaths(newHtml).map((c) => c.path));
  const oldTables = new Set(collectEachPaths(oldHtml ?? ''));
  const newTables = new Set(collectEachPaths(newHtml));

  return {
    addedFields: [...newFields].filter((f) => !oldFields.has(f)).sort(),
    removedFields: [...oldFields].filter((f) => !newFields.has(f)).sort(),
    addedTables: [...newTables].filter((t) => !oldTables.has(t)).sort(),
    removedTables: [...oldTables].filter((t) => !newTables.has(t)).sort(),
  };
}

import { Block, DocumentTemplateDoc } from '@/types/document-template';
import { BLOCK_LABELS } from './blocks';

/**
 * What changed between two versions, for the publish dialog.
 *
 * Keyed on the stable block id, which is the only way to tell a MOVE from a
 * delete-plus-add. Reporting a reorder as "removed 4 blocks, added 4 blocks"
 * is technically true and completely useless to somebody deciding whether it
 * is safe to publish.
 */

export type ChangeKind = 'added' | 'removed' | 'changed' | 'moved';

export interface BlockChange {
  kind: ChangeKind;
  blockId: string;
  label: string;
  /** Old → new index, for a move. */
  from?: number;
  to?: number;
}

export interface DocDiff {
  blocks: BlockChange[];
  /** Page setup and theme changes, described in words. */
  settings: string[];
}

function describe(block: Block): string {
  const label = BLOCK_LABELS[block.type] ?? block.type;
  if (block.type === 'heading' || block.type === 'text') {
    const text = String(block.props.html ?? '')
      .replace(/<[^>]*>/g, '')
      .trim()
      .slice(0, 40);
    return text ? `${label} “${text}”` : label;
  }
  if (block.type === 'dataTable' && block.props.bind) {
    return `${label} (${block.props.bind})`;
  }
  if (block.type === 'signature' && block.props.slotKey) {
    return `${label} (${block.props.slotKey})`;
  }
  return label;
}

/** Deep equality by serialisation. Block props are plain JSON by construction. */
function sameContent(a: Block, b: Block): boolean {
  const strip = (x: Block) => JSON.stringify({ ...x, id: undefined });
  return strip(a) === strip(b);
}

export function diffDocs(
  before: DocumentTemplateDoc | null,
  after: DocumentTemplateDoc,
): DocDiff {
  const changes: BlockChange[] = [];
  const settings: string[] = [];

  const beforeBody = before?.body ?? [];
  const afterBody = after.body ?? [];
  const beforeById = new Map(beforeBody.map((b, i) => [b.id, { block: b, index: i }]));
  const afterById = new Map(afterBody.map((b, i) => [b.id, { block: b, index: i }]));

  for (const [id, { block, index }] of afterById) {
    const prev = beforeById.get(id);
    if (!prev) {
      changes.push({ kind: 'added', blockId: id, label: describe(block), to: index });
      continue;
    }
    if (!sameContent(prev.block, block)) {
      changes.push({ kind: 'changed', blockId: id, label: describe(block) });
    }
    if (prev.index !== index) {
      changes.push({
        kind: 'moved',
        blockId: id,
        label: describe(block),
        from: prev.index,
        to: index,
      });
    }
  }

  for (const [id, { block, index }] of beforeById) {
    if (!afterById.has(id)) {
      changes.push({ kind: 'removed', blockId: id, label: describe(block), from: index });
    }
  }

  if (before) {
    if (before.page.size !== after.page.size) {
      settings.push(`Paper size ${before.page.size} → ${after.page.size}`);
    }
    if (before.page.orientation !== after.page.orientation) {
      settings.push(`Orientation ${before.page.orientation} → ${after.page.orientation}`);
    }
    const bm = before.page.margin;
    const am = after.page.margin;
    if (bm.top !== am.top || bm.right !== am.right || bm.bottom !== am.bottom || bm.left !== am.left) {
      settings.push(
        `Margins ${bm.top}/${bm.right}/${bm.bottom}/${bm.left}mm → ${am.top}/${am.right}/${am.bottom}/${am.left}mm`,
      );
    }
    if (before.page.letterhead?.source !== after.page.letterhead?.source) {
      settings.push(
        `Letterhead ${before.page.letterhead?.source ?? 'none'} → ${after.page.letterhead?.source ?? 'none'}`,
      );
    }
    if (before.locale !== after.locale) settings.push(`Language ${before.locale} → ${after.locale}`);
  }

  return { blocks: changes, settings };
}

import {
  Block,
  BlockType,
  Condition,
  DOC_SCHEMA_VERSION,
  DocumentTemplateDoc,
} from '@/types/document-template';

/**
 * Block-document helpers for the builder.
 *
 * Pure and synchronous on purpose: this is where a non-technical user's
 * clicking becomes the structure the server compiles, so it is the layer that
 * most deserves exhaustive unit tests — and those are only cheap if nothing
 * here touches React or the network.
 */

/**
 * A new block id.
 *
 * `crypto.randomUUID` where available, with a counter fallback. Stability
 * matters more than uniqueness across machines: the id is what the inspector
 * selects on, what dnd-kit sorts by, and what the publish diff uses to tell a
 * MOVE from a delete-plus-add. An array index would break all three.
 */
let fallbackCounter = 0;
export function newBlockId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  fallbackCounter += 1;
  return `b-${Date.now().toString(36)}-${fallbackCounter}`;
}

export const BLOCK_LABELS: Record<BlockType, string> = {
  heading: 'Heading',
  text: 'Text',
  logo: 'Logo',
  keyValue: 'Detail list',
  dataTable: 'Table',
  signature: 'Signature',
  spacer: 'Spacer',
  divider: 'Divider',
  pageBreak: 'Page break',
  rawHtml: 'Advanced HTML',
};

/** A sensible new block of each type, so nothing is added empty and confusing. */
export function makeBlock(type: BlockType): Block {
  const id = newBlockId();
  switch (type) {
    case 'heading':
      return { id, type, props: { html: 'Heading', level: 2, align: 'start' } };
    case 'text':
      return { id, type, props: { html: '<p>Write here…</p>' } };
    case 'logo':
      return { id, type, props: { source: 'brand', maxHeightMm: 16, align: 'start' } };
    case 'keyValue':
      return {
        id,
        type,
        props: { rows: [{ label: 'Name', value: '{{employeeName}}' }], labelWidthPct: 38, hideEmptyRows: true },
      };
    case 'dataTable':
      return {
        id,
        type,
        props: { bind: '', columns: [], showHeader: true, emptyText: 'Nothing to show.' },
      };
    case 'signature':
      return { id, type, props: { slotKey: 'hr', showImage: true, align: 'start' } };
    case 'spacer':
      return { id, type, props: { heightMm: 8 } };
    case 'divider':
      return { id, type, props: { thicknessPt: 1 } };
    case 'pageBreak':
      return { id, type, props: {} };
    case 'rawHtml':
      return { id, type, props: { html: '<p></p>' } };
    default: {
      const never: never = type;
      throw new Error(`Unknown block type ${never}`);
    }
  }
}

/** Move a block within the body. Returns a NEW array; never mutates. */
export function moveBlock(body: Block[], fromIndex: number, toIndex: number): Block[] {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= body.length ||
    toIndex >= body.length
  ) {
    return body;
  }
  const next = [...body];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

/**
 * Remove a block, unless it is locked.
 *
 * A locked block is shown with its reason rather than hidden: a builder that
 * silently omits required blocks just produces confusing failures later, when
 * the document renders without something it needed.
 */
export function removeBlock(body: Block[], id: string): Block[] {
  return body.filter((b) => b.id !== id || b.locked);
}

export function replaceBlock(body: Block[], id: string, next: Block): Block[] {
  return body.map((b) => (b.id === id ? next : b));
}

export function insertBlock(body: Block[], block: Block, atIndex?: number): Block[] {
  const next = [...body];
  next.splice(atIndex ?? next.length, 0, block);
  return next;
}

/** Duplicate a block, with a fresh id so the two are independently selectable. */
export function duplicateBlock(body: Block[], id: string): Block[] {
  const index = body.findIndex((b) => b.id === id);
  if (index < 0) return body;
  const source = body[index];
  const copy = JSON.parse(JSON.stringify(source)) as Block;
  copy.id = newBlockId();
  copy.locked = false;
  return insertBlock(body, copy, index + 1);
}

/**
 * Read a stored document defensively.
 *
 * An unknown FUTURE schemaVersion is refused, because guessing at a shape a
 * newer builder wrote is how a template silently loses content on save. An
 * unknown BLOCK type is kept rather than dropped, for the same reason from the
 * other direction: round-tripping a document through an older client must not
 * quietly delete blocks it did not recognise.
 */
export function parseDoc(raw: unknown): DocumentTemplateDoc {
  if (!raw || typeof raw !== 'object') {
    throw new Error('This template has no content yet.');
  }
  const doc = raw as DocumentTemplateDoc;
  if (typeof doc.schemaVersion !== 'number') {
    throw new Error('This template is not a valid document.');
  }
  if (doc.schemaVersion > DOC_SCHEMA_VERSION) {
    throw new Error(
      `This template was saved by a newer version of the builder (v${doc.schemaVersion}). Update before editing it.`,
    );
  }
  if (!Array.isArray(doc.body)) {
    return { ...doc, body: [] };
  }
  return doc;
}

/** Every `{{token}}` a document references, deduplicated. */
export function collectTokens(doc: DocumentTemplateDoc): string[] {
  const found = new Set<string>();
  const scan = (text: unknown) => {
    if (typeof text !== 'string') return;
    for (const m of text.matchAll(/\{\{\s*([^}\s#/]+)\s*\}\}/g)) {
      found.add(m[1]);
    }
  };

  for (const block of doc.body ?? []) {
    const props = block.props as Record<string, unknown>;
    scan(props.html);
    if (block.type === 'keyValue') {
      for (const row of block.props.rows ?? []) {
        scan(row.label);
        scan(row.value);
      }
    }
    if (block.type === 'dataTable') {
      if (block.props.bind) found.add(block.props.bind);
      for (const col of block.props.columns ?? []) found.add(`${block.props.bind}.${col.key}`);
    }
    if (block.visibleWhen) {
      collectConditionPaths(block.visibleWhen).forEach((p) => found.add(p));
    }
  }
  scan(doc.footer?.html);
  return [...found];
}

/** Field paths a condition tree references. */
export function collectConditionPaths(condition: Condition): string[] {
  if (condition.op === 'and' || condition.op === 'or') {
    return condition.all.flatMap(collectConditionPaths);
  }
  // Narrowed by the PROPERTY rather than by eliminating operators one at a
  // time: the operator list grows, and a discriminant check that has to stay
  // in step with it is a check that will drift.
  return 'path' in condition ? [condition.path] : [];
}

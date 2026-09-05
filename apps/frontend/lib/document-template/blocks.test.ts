import { describe, expect, it } from 'vitest';
import {
  collectTokens,
  duplicateBlock,
  insertBlock,
  makeBlock,
  moveBlock,
  newBlockId,
  parseDoc,
  removeBlock,
  replaceBlock,
} from './blocks';
import { Block, DocumentTemplateDoc } from '@/types/document-template';

const doc = (body: Block[]): DocumentTemplateDoc => ({
  schemaVersion: 1,
  documentType: 'SALARY_CERTIFICATE',
  locale: 'en',
  dir: 'ltr',
  page: {
    size: 'A4',
    orientation: 'portrait',
    margin: { top: 20, right: 18, bottom: 20, left: 18 },
    letterhead: { source: 'company', firstPageOnly: true },
  },
  theme: { followBrand: true },
  body,
});

describe('newBlockId', () => {
  it('is unique', () => {
    const ids = new Set(Array.from({ length: 200 }, newBlockId));
    expect(ids.size).toBe(200);
  });
});

describe('makeBlock', () => {
  it('creates every block type with usable defaults', () => {
    const types = [
      'heading', 'text', 'logo', 'keyValue', 'dataTable',
      'signature', 'spacer', 'divider', 'pageBreak', 'rawHtml',
    ] as const;
    for (const type of types) {
      const block = makeBlock(type);
      expect(block.type).toBe(type);
      expect(block.id).toBeTruthy();
      expect(block.props).toBeDefined();
    }
  });

  it('gives a new detail list a real row rather than an empty one', () => {
    // A block that appears empty reads as broken; a block with one example row
    // shows what it is for.
    const block = makeBlock('keyValue');
    expect((block.props as any).rows).toHaveLength(1);
  });
});

describe('moveBlock', () => {
  const body = [makeBlock('heading'), makeBlock('text'), makeBlock('signature')];

  it('reorders without mutating the original', () => {
    const moved = moveBlock(body, 0, 2);
    expect(moved.map((b) => b.type)).toEqual(['text', 'signature', 'heading']);
    expect(body.map((b) => b.type)).toEqual(['heading', 'text', 'signature']);
  });

  it('is a no-op for an unchanged or out-of-range index', () => {
    expect(moveBlock(body, 1, 1)).toBe(body);
    expect(moveBlock(body, -1, 0)).toBe(body);
    expect(moveBlock(body, 0, 9)).toBe(body);
  });
});

describe('removeBlock', () => {
  it('removes an ordinary block', () => {
    const body = [makeBlock('heading'), makeBlock('text')];
    expect(removeBlock(body, body[0].id)).toHaveLength(1);
  });

  it('refuses to remove a locked block', () => {
    // Locked blocks are shown WITH their reason rather than hidden: a builder
    // that silently omits a required block just produces a confusing failure
    // later, when the document renders without something it needed.
    const locked = { ...makeBlock('heading'), locked: true };
    const body = [locked, makeBlock('text')];
    expect(removeBlock(body, locked.id)).toHaveLength(2);
  });
});

describe('duplicateBlock', () => {
  it('copies with a NEW id, placed directly after the original', () => {
    // A shared id would make the two blocks indistinguishable to the
    // inspector, to dnd-kit, and to the publish diff.
    const body = [makeBlock('heading'), makeBlock('text')];
    const next = duplicateBlock(body, body[0].id);
    expect(next).toHaveLength(3);
    expect(next[1].type).toBe('heading');
    expect(next[1].id).not.toBe(body[0].id);
  });

  it('does not copy the locked flag', () => {
    const locked = { ...makeBlock('heading'), locked: true };
    const next = duplicateBlock([locked], locked.id);
    expect(next[1].locked).toBe(false);
  });

  it('deep-copies, so editing the copy does not change the original', () => {
    const source = makeBlock('keyValue');
    const next = duplicateBlock([source], source.id);
    (next[1].props as any).rows[0].label = 'CHANGED';
    expect((next[0].props as any).rows[0].label).toBe('Name');
  });
});

describe('insertBlock / replaceBlock', () => {
  it('inserts at an index and appends by default', () => {
    const body = [makeBlock('heading')];
    const b = makeBlock('text');
    expect(insertBlock(body, b)).toHaveLength(2);
    expect(insertBlock(body, b, 0)[0].type).toBe('text');
  });

  it('replaces by id', () => {
    const body = [makeBlock('heading'), makeBlock('text')];
    const replacement = { ...body[0], props: { html: 'X', level: 1 as const } };
    expect((replaceBlock(body, body[0].id, replacement as Block)[0].props as any).html).toBe('X');
  });
});

describe('parseDoc', () => {
  it('refuses a document from a NEWER builder rather than guessing', () => {
    // Guessing at a shape a newer client wrote is how a template silently
    // loses content the moment it is saved back.
    expect(() => parseDoc({ ...doc([]), schemaVersion: 2 })).toThrow(/newer version/i);
  });

  it('refuses something that is not a document at all', () => {
    expect(() => parseDoc(null)).toThrow(/no content/i);
    expect(() => parseDoc({ body: [] })).toThrow(/not a valid document/i);
  });

  it('tolerates a missing body', () => {
    expect(parseDoc({ ...doc([]), body: undefined }).body).toEqual([]);
  });

  it('KEEPS an unknown block type rather than dropping it', () => {
    // The other direction of the same rule: round-tripping through an older
    // client must not quietly delete blocks it did not recognise.
    const unknown = { id: 'x', type: 'hologram', props: {} } as unknown as Block;
    expect(parseDoc(doc([unknown])).body).toHaveLength(1);
  });
});

describe('collectTokens', () => {
  it('finds tokens in rich text, detail rows and the footer', () => {
    const d = doc([
      { id: 'a', type: 'text', props: { html: '<p>Dear {{employeeName}}</p>' } },
      {
        id: 'b',
        type: 'keyValue',
        props: { rows: [{ label: '{{labelToken}}', value: '{{baseSalary}}' }] },
      },
    ]);
    d.footer = { html: '{{companyName}}', showPageNumbers: true };
    const tokens = collectTokens(d);
    expect(tokens).toEqual(
      expect.arrayContaining(['employeeName', 'labelToken', 'baseSalary', 'companyName']),
    );
  });

  it('reports a table as its collection plus its bound columns', () => {
    const d = doc([
      {
        id: 't',
        type: 'dataTable',
        props: {
          bind: 'earnings',
          columns: [{ key: 'label', header: 'Component' }, { key: 'amount', header: 'Amount' }],
        },
      },
    ]);
    expect(collectTokens(d)).toEqual(
      expect.arrayContaining(['earnings', 'earnings.label', 'earnings.amount']),
    );
  });

  it('includes paths a visibility rule depends on', () => {
    const d = doc([
      {
        id: 'a',
        type: 'text',
        props: { html: '<p>x</p>' },
        visibleWhen: {
          op: 'and',
          all: [
            { op: 'truthy', path: 'onProbation' },
            { op: 'eq', path: 'status', value: 'ACTIVE' },
          ],
        },
      },
    ]);
    expect(collectTokens(d)).toEqual(expect.arrayContaining(['onProbation', 'status']));
  });

  it('does not report block helpers as fields', () => {
    const d = doc([{ id: 'a', type: 'text', props: { html: '{{#if x}}y{{/if}}' } }]);
    expect(collectTokens(d)).not.toContain('#if');
    expect(collectTokens(d)).not.toContain('/if');
  });

  it('deduplicates', () => {
    const d = doc([
      { id: 'a', type: 'text', props: { html: '{{employeeName}} {{employeeName}}' } },
    ]);
    expect(collectTokens(d).filter((t) => t === 'employeeName')).toHaveLength(1);
  });
});

import { describe, expect, it } from 'vitest';
import { diffDocs } from './diff';
import { makeBlock } from './blocks';
import { Block, DocumentTemplateDoc } from '@/types/document-template';

const doc = (body: Block[], over: Partial<DocumentTemplateDoc> = {}): DocumentTemplateDoc => ({
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
  ...over,
});

describe('diffDocs', () => {
  it('reports an addition', () => {
    const a = doc([makeBlock('heading')]);
    const added = makeBlock('text');
    const b = doc([...a.body, added]);
    const d = diffDocs(a, b);
    expect(d.blocks).toEqual([
      expect.objectContaining({ kind: 'added', blockId: added.id }),
    ]);
  });

  it('reports a removal', () => {
    const gone = makeBlock('text');
    const a = doc([makeBlock('heading'), gone]);
    const b = doc([a.body[0]]);
    expect(diffDocs(a, b).blocks).toEqual([
      expect.objectContaining({ kind: 'removed', blockId: gone.id }),
    ]);
  });

  it('reports a content change without reporting a move', () => {
    const a = doc([makeBlock('text')]);
    const edited: Block = { ...a.body[0], props: { html: '<p>new</p>' } } as Block;
    const d = diffDocs(a, doc([edited]));
    expect(d.blocks.map((c) => c.kind)).toEqual(['changed']);
  });

  it('reports a REORDER as moves, not as removals plus additions', () => {
    // This is the whole reason the diff keys on block ids. Telling somebody
    // deciding whether to publish that four blocks were deleted and four added
    // is technically true and completely useless.
    const a = doc([makeBlock('heading'), makeBlock('text'), makeBlock('signature')]);
    const b = doc([a.body[2], a.body[0], a.body[1]]);
    const d = diffDocs(a, b);
    expect(d.blocks.every((c) => c.kind === 'moved')).toBe(true);
    expect(d.blocks).toHaveLength(3);
    expect(d.blocks.map((c) => c.kind)).not.toContain('removed');
    expect(d.blocks.map((c) => c.kind)).not.toContain('added');
  });

  it('carries the from/to positions of a move', () => {
    const a = doc([makeBlock('heading'), makeBlock('text')]);
    const b = doc([a.body[1], a.body[0]]);
    const moved = diffDocs(a, b).blocks.find((c) => c.blockId === a.body[0].id);
    expect(moved).toMatchObject({ kind: 'moved', from: 0, to: 1 });
  });

  it('reports nothing for an identical document', () => {
    const a = doc([makeBlock('heading'), makeBlock('text')]);
    const d = diffDocs(a, doc([...a.body]));
    expect(d.blocks).toHaveLength(0);
    expect(d.settings).toHaveLength(0);
  });

  it('describes a heading by its text, so the list is readable', () => {
    const heading = { ...makeBlock('heading'), props: { html: 'SALARY CERTIFICATE', level: 1 } } as Block;
    const d = diffDocs(doc([]), doc([heading]));
    expect(d.blocks[0].label).toContain('SALARY CERTIFICATE');
  });

  it('reports page-setup changes in words', () => {
    const a = doc([]);
    const b = doc([], {
      page: { ...a.page, orientation: 'landscape', margin: { top: 10, right: 10, bottom: 10, left: 10 } },
    });
    const d = diffDocs(a, b);
    expect(d.settings.join(' ')).toMatch(/Orientation portrait → landscape/);
    expect(d.settings.join(' ')).toMatch(/Margins/);
  });

  it('reports a letterhead change, which is what people notice on paper', () => {
    const a = doc([]);
    const b = doc([], { page: { ...a.page, letterhead: { source: 'none', firstPageOnly: true } } });
    expect(diffDocs(a, b).settings.join(' ')).toMatch(/Letterhead company → none/);
  });

  it('treats a first version as all additions rather than throwing', () => {
    const b = doc([makeBlock('heading')]);
    const d = diffDocs(null, b);
    expect(d.blocks.map((c) => c.kind)).toEqual(['added']);
    expect(d.settings).toHaveLength(0);
  });
});

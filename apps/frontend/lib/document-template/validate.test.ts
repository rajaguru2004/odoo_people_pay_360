import { describe, expect, it } from 'vitest';
import { canPublish, didYouMean, manifestPaths, validateDoc } from './validate';
import { Block, DocumentTemplateDoc, TokenManifest } from '@/types/document-template';

const manifest: TokenManifest = {
  documentType: 'PAYSLIP',
  name: 'Payslip',
  groups: [
    {
      group: 'Employee',
      tokens: [
        { path: 'employeeName', label: 'Employee name', type: 'string', sampleValue: 'Ahmed', alwaysPresent: true, columns: null },
        { path: 'passportNumber', label: 'Passport', type: 'string', sampleValue: 'A1', alwaysPresent: false, columns: null },
      ],
    },
    {
      group: 'Signature',
      tokens: [
        { path: 'signatory.hr.name', label: 'HR name', type: 'string', sampleValue: 'Fatma', alwaysPresent: false, columns: null },
      ],
    },
  ],
  collections: [
    {
      path: 'earnings',
      label: 'Earnings',
      fields: [
        { name: 'label', label: 'Component', type: 'string' },
        { name: 'amount', label: 'Amount', type: 'money' },
      ],
      sampleRows: [],
    },
  ],
  sample: {},
};

const doc = (body: Block[]): DocumentTemplateDoc => ({
  schemaVersion: 1,
  documentType: 'PAYSLIP',
  locale: 'en',
  dir: 'ltr',
  page: {
    size: 'A4',
    orientation: 'portrait',
    margin: { top: 20, right: 18, bottom: 20, left: 18 },
  },
  theme: { followBrand: true },
  body,
});

const codes = (d: DocumentTemplateDoc) => validateDoc(d, manifest).map((i) => i.code);
const errors = (d: DocumentTemplateDoc) =>
  validateDoc(d, manifest).filter((i) => i.level === 'error');

describe('manifestPaths', () => {
  it('includes collection columns as dotted paths', () => {
    const paths = manifestPaths(manifest);
    expect(paths.has('earnings')).toBe(true);
    expect(paths.has('earnings.amount')).toBe(true);
  });
});

describe('unknown tokens', () => {
  it('is an ERROR, because the document would print blank', () => {
    const d = doc([{ id: 'a', type: 'text', props: { html: '<p>{{grade}}</p>' } }]);
    expect(codes(d)).toContain('UNKNOWN_TOKEN');
    expect(canPublish(validateDoc(d, manifest))).toBe(false);
  });

  it('accepts a known token', () => {
    const d = doc([{ id: 'a', type: 'text', props: { html: '<p>{{employeeName}}</p>' } }]);
    expect(codes(d)).not.toContain('UNKNOWN_TOKEN');
  });

  it('accepts the custom.* namespace wholesale', () => {
    // Custom fields are per-branch configuration that changes without a
    // deploy, so the manifest declares the namespace and not every member.
    // Validating members here would reject fields that genuinely exist.
    const d = doc([{ id: 'a', type: 'text', props: { html: '{{custom.jobGrade}}' } }]);
    expect(codes(d)).not.toContain('UNKNOWN_TOKEN');
  });

  it('accepts a nested path under a declared prefix', () => {
    const d = doc([{ id: 'a', type: 'text', props: { html: '{{signatory.hr.name}}' } }]);
    expect(codes(d)).not.toContain('UNKNOWN_TOKEN');
  });

  it('checks detail rows, both label and value', () => {
    const d = doc([
      { id: 'a', type: 'keyValue', props: { rows: [{ label: '{{nope}}', value: '{{employeeName}}' }] } },
    ]);
    expect(errors(d)).toHaveLength(1);
  });

  it('checks the footer', () => {
    const d = doc([]);
    d.footer = { html: '{{nope}}', showPageNumbers: true };
    expect(codes(d)).toContain('UNKNOWN_TOKEN');
  });
});

describe('optional tokens', () => {
  it('are a WARNING, never a block on publishing', () => {
    // Blocking on a warning trains people to ignore warnings, and then the
    // errors get ignored too.
    const d = doc([{ id: 'a', type: 'text', props: { html: '{{passportNumber}}' } }]);
    const issues = validateDoc(d, manifest);
    expect(issues.some((i) => i.code === 'OPTIONAL_NO_FALLBACK' && i.level === 'warning')).toBe(true);
    expect(canPublish(issues)).toBe(true);
  });
});

describe('tables', () => {
  it('errors when unbound', () => {
    const d = doc([{ id: 't', type: 'dataTable', props: { bind: '', columns: [] } }]);
    expect(codes(d)).toContain('UNBOUND_COLLECTION');
    expect(codes(d)).toContain('NO_COLUMNS');
  });

  it('errors when bound to something that is not a list', () => {
    const d = doc([
      { id: 't', type: 'dataTable', props: { bind: 'employeeName', columns: [{ key: 'a', header: 'A' }] } },
    ]);
    expect(codes(d)).toContain('UNBOUND_COLLECTION');
  });

  it('accepts a real collection with columns', () => {
    const d = doc([
      {
        id: 't',
        type: 'dataTable',
        props: { bind: 'earnings', columns: [{ key: 'amount', header: 'Amount' }] },
      },
    ]);
    expect(errors(d)).toHaveLength(0);
  });
});

describe('conditions', () => {
  it('errors on a rule that refers to a field the document does not have', () => {
    const d = doc([
      {
        id: 'a',
        type: 'text',
        props: { html: '<p>x</p>' },
        visibleWhen: { op: 'eq', path: 'nonexistent', value: 'x' },
      },
    ]);
    expect(codes(d)).toContain('UNKNOWN_CONDITION_PATH');
  });

  it('walks a nested AND', () => {
    const d = doc([
      {
        id: 'a',
        type: 'text',
        props: { html: '<p>x</p>' },
        visibleWhen: {
          op: 'and',
          all: [
            { op: 'truthy', path: 'employeeName' },
            { op: 'truthy', path: 'nope' },
          ],
        },
      },
    ]);
    expect(errors(d)).toHaveLength(1);
  });
});

describe('empty content', () => {
  it('errors on a template with no blocks', () => {
    expect(canPublish(validateDoc(doc([]), manifest))).toBe(false);
  });

  it('warns on an empty text block without blocking', () => {
    const d = doc([
      { id: 'a', type: 'text', props: { html: '<p></p>' } },
      { id: 'b', type: 'text', props: { html: '<p>{{employeeName}}</p>' } },
    ]);
    const issues = validateDoc(d, manifest);
    expect(issues.some((i) => i.code === 'EMPTY_BLOCK' && i.level === 'warning')).toBe(true);
    expect(canPublish(issues)).toBe(true);
  });
});

describe('didYouMean', () => {
  it('suggests a close match', () => {
    expect(didYouMean('employeeNam', manifestPaths(manifest))).toBe('employeeName');
  });

  it('suggests nothing for something wildly different', () => {
    // A suggestion that is barely closer than random sends the user off to
    // check something irrelevant.
    expect(didYouMean('zzzzzzzzzzzzzzzz', manifestPaths(manifest))).toBeNull();
  });
});

describe('without a manifest', () => {
  it('still reports structural problems but claims nothing about tokens', () => {
    // The manifest can legitimately be still loading. Guessing that every
    // token is unknown would paint the whole document red.
    const d = doc([{ id: 'a', type: 'text', props: { html: '{{anything}}' } }]);
    const issues = validateDoc(d, null);
    expect(issues.some((i) => i.code === 'UNKNOWN_TOKEN')).toBe(false);
  });
});

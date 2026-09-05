import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TemplateBuilder from './TemplateBuilder';
import documentTemplateService from '@/services/documentTemplateService';
import { DocumentTemplateDoc, TokenManifest } from '@/types/document-template';

vi.mock('@/services/documentTemplateService', () => ({
  default: {
    saveDraft: vi.fn(async () => ({ updatedAt: '2026-09-03T00:00:01.000Z', contentHash: 'h2' })),
    publish: vi.fn(async () => ({})),
    previewHtml: vi.fn(async () => ({ html: '<html><body>PREVIEWED</body></html>', removed: [] })),
    listAssets: vi.fn(async () => [
      {
        id: 'lh-1',
        kind: 'LETTERHEAD',
        name: 'Company letter pad',
        scope: 'COMPANY',
        branchId: null,
        branchName: null,
        mimeType: 'image/png',
        fileSize: 2048,
        widthPx: 1240,
        heightPx: 1754,
        safeTopMm: 35,
        safeRightMm: 18,
        safeBottomMm: 25,
        safeLeftMm: 18,
        isActive: true,
        createdAt: '2026-09-03T00:00:00.000Z',
        previewPath: '/secure-files/document-asset/lh-1',
      },
    ]),
  },
}));

const manifest: TokenManifest = {
  documentType: 'SALARY_CERTIFICATE',
  name: 'Salary certificate',
  groups: [
    {
      group: 'Employee',
      tokens: [
        {
          path: 'employeeName',
          label: 'Employee name',
          type: 'string',
          sampleValue: 'Ahmed',
          alwaysPresent: true,
          columns: null,
        },
      ],
    },
  ],
  collections: [
    {
      path: 'earnings',
      label: 'Earnings',
      fields: [{ name: 'amount', label: 'Amount', type: 'money' }],
      sampleRows: [],
    },
  ],
  sample: {},
};

const doc: DocumentTemplateDoc = {
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
  body: [
    { id: 'h1', type: 'heading', props: { html: 'SALARY CERTIFICATE', level: 1, align: 'center' } },
    { id: 't1', type: 'text', props: { html: '<p>Dear {{employeeName}}</p>' } },
  ],
};

const renderBuilder = (over: Partial<Parameters<typeof TemplateBuilder>[0]> = {}) =>
  render(
    <TemplateBuilder
      versionId="v1"
      initialDoc={JSON.parse(JSON.stringify(doc))}
      initialUpdatedAt="2026-09-03T00:00:00.000Z"
      manifest={manifest}
      canPublishTemplate
      publishedDoc={null}
      {...over}
    />,
  );

describe('TemplateBuilder', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists the blocks in the document', () => {
    renderBuilder();
    const list = screen.getByTestId('block-list');
    expect(within(list).getByText('Heading')).toBeTruthy();
    expect(within(list).getByText('Text')).toBeTruthy();
  });

  it('adds a block from the palette', async () => {
    renderBuilder();
    await userEvent.click(screen.getByRole('button', { name: /Detail list/ }));
    expect(within(screen.getByTestId('block-list')).getByText('Detail list')).toBeTruthy();
  });

  it('reorders with BUTTONS, which is both the keyboard path and the testable one', async () => {
    // A drag-only builder is unusable to a keyboard user and untestable in
    // jsdom. Making the accessible path the only path resolves both at once.
    renderBuilder();
    const before = within(screen.getByTestId('block-list')).getAllByRole('button', {
      name: /^(Heading|Text)$/,
    });
    expect(before[0].textContent).toContain('Heading');

    await userEvent.click(screen.getByRole('button', { name: /Move Text up/ }));

    const after = within(screen.getByTestId('block-list')).getAllByRole('button', {
      name: /^(Heading|Text)$/,
    });
    expect(after[0].textContent).toContain('Text');
  });

  it('deletes a block, and refuses to delete a locked one', async () => {
    renderBuilder({
      initialDoc: {
        ...doc,
        body: [{ ...doc.body[0], locked: true }, doc.body[1]],
      },
    });
    expect(screen.getByRole('button', { name: /Delete Heading/ })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: /Delete Text/ }));
    expect(within(screen.getByTestId('block-list')).queryByText('Text')).toBeNull();
  });

  it('selects a block and shows its properties', async () => {
    renderBuilder();
    await userEvent.click(within(screen.getByTestId('block-list')).getByText('Text'));
    const inspector = screen.getByTestId('block-inspector');
    expect(within(inspector).getByLabelText('Block content')).toBeTruthy();
  });

  it('undoes the last change', async () => {
    renderBuilder();
    await userEvent.click(screen.getByRole('button', { name: /Detail list/ }));
    expect(within(screen.getByTestId('block-list')).getByText('Detail list')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Undo/ }));
    expect(within(screen.getByTestId('block-list')).queryByText('Detail list')).toBeNull();
  });

  it('blocks publishing on an ERROR and says why', async () => {
    renderBuilder({
      initialDoc: {
        ...doc,
        body: [{ id: 'x', type: 'text', props: { html: '<p>{{noSuchField}}</p>' } }],
      },
    });
    const publish = screen.getByTestId('publish-button');
    expect(publish).toBeDisabled();
    expect(publish.getAttribute('title')).toMatch(/Fix the problems/i);
    expect(within(screen.getByTestId('validation-tray')).getByText(/not a field/i)).toBeTruthy();
  });

  it('does NOT block publishing on a warning alone', async () => {
    // Blocking on warnings trains people to ignore them, and then the errors
    // get ignored too.
    renderBuilder({
      initialDoc: {
        ...doc,
        body: [
          { id: 'a', type: 'text', props: { html: '<p></p>' } },
          { id: 'b', type: 'text', props: { html: '<p>{{employeeName}}</p>' } },
        ],
      },
    });
    expect(screen.getByTestId('publish-button')).not.toBeDisabled();
    expect(screen.getByTestId('validation-tray')).toBeTruthy();
  });

  it('hides Publish entirely from someone who may not publish', () => {
    // HR can draft; only an administrator ships, because publishing changes
    // what goes out to banks.
    renderBuilder({ canPublishTemplate: false });
    expect(screen.queryByTestId('publish-button')).toBeNull();
  });

  describe('letterhead', () => {
    it('offers the uploaded letter pads right in the builder', async () => {
      // The question people arrive with is "where do I put my letter pad?".
      // Answering it only on a separate screen is how it stayed undiscoverable.
      renderBuilder();
      const select = await screen.findByTestId('letterhead-select');
      await waitFor(() =>
        expect(within(select).getByText(/Company letter pad/)).toBeTruthy(),
      );
      expect(within(select).getByText(/No letterhead/)).toBeTruthy();
    });

    it('starts on the letter pad the draft is already pinned to', async () => {
      // Otherwise the picker resets to "none" on every load and the next
      // autosave silently unpins the artwork.
      renderBuilder({ initialLetterheadId: 'lh-1' });
      const select = (await screen.findByTestId('letterhead-select')) as HTMLSelectElement;
      await waitFor(() => expect(select.value).toBe('lh-1'));
    });

    it('SAVES the chosen letter pad with the draft', async () => {
      renderBuilder();
      const select = await screen.findByTestId('letterhead-select');
      await waitFor(() => expect(within(select).getByText(/Company letter pad/)).toBeTruthy());
      await userEvent.selectOptions(select, 'lh-1');
      await waitFor(
        () =>
          expect(documentTemplateService.saveDraft).toHaveBeenCalledWith(
            'v1',
            expect.objectContaining({ letterheadId: 'lh-1' }),
          ),
        { timeout: 4000 },
      );
    });

    it('previews WITH the letterhead, so the author sees the real page', async () => {
      renderBuilder({ initialLetterheadId: 'lh-1' });
      await screen.findByTestId('letterhead-select');
      await userEvent.click(screen.getByRole('button', { name: /Preview/ }));
      await waitFor(() =>
        expect(documentTemplateService.previewHtml).toHaveBeenCalledWith(
          expect.objectContaining({ letterheadId: 'lh-1' }),
        ),
      );
    });

    it('says where to get one when none has been uploaded', async () => {
      (documentTemplateService.listAssets as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
      renderBuilder();
      await waitFor(() =>
        expect(screen.getByText(/No letter pad uploaded yet/i)).toBeTruthy(),
      );
      expect(screen.getByRole('link', { name: /Upload one/i })).toBeTruthy();
    });
  });

  it('renders a preview in a SANDBOXED iframe', async () => {
    renderBuilder();
    await userEvent.click(screen.getByRole('button', { name: /Preview/ }));
    await waitFor(() => expect(screen.getByTitle('Document preview')).toBeTruthy());
    const frame = screen.getByTitle('Document preview') as HTMLIFrameElement;
    // The preview renders admin-authored markup; it must not be able to script
    // the page around it.
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toContain('PREVIEWED');
  });

  it('sends the expected updatedAt on save, so a stale write is refused', async () => {
    renderBuilder();
    await userEvent.click(screen.getByRole('button', { name: /Detail list/ }));
    await waitFor(
      () =>
        expect(documentTemplateService.saveDraft).toHaveBeenCalledWith(
          'v1',
          expect.objectContaining({ expectedUpdatedAt: '2026-09-03T00:00:00.000Z' }),
        ),
      { timeout: 4000 },
    );
  });

  it('surfaces a save conflict rather than losing the edit', async () => {
    (documentTemplateService.saveDraft as ReturnType<typeof vi.fn>).mockRejectedValue({
      message: 'This draft was changed by someone else since you opened it.',
    });
    renderBuilder();
    await userEvent.click(screen.getByRole('button', { name: /Detail list/ }));
    await waitFor(
      () => expect(screen.getByRole('alert').textContent).toMatch(/changed by someone else/i),
      { timeout: 4000 },
    );
    // The block the user added is still on screen — the conflict is reported,
    // not resolved by throwing their work away.
    expect(within(screen.getByTestId('block-list')).getByText('Detail list')).toBeTruthy();
  });

  it('tells the user when the sanitizer removed something', async () => {
    (documentTemplateService.saveDraft as ReturnType<typeof vi.fn>).mockResolvedValue({
      updatedAt: 'x',
      contentHash: 'h',
      removed: ['<script>'],
    });
    renderBuilder();
    await userEvent.click(screen.getByRole('button', { name: /Detail list/ }));
    await waitFor(
      () => expect(screen.getByRole('alert').textContent).toMatch(/removed for safety/i),
      { timeout: 4000 },
    );
  });
});

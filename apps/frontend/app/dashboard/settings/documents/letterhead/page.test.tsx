import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LetterheadPage from './page';
import documentTemplateService from '@/services/documentTemplateService';

vi.mock('@/services/documentTemplateService', () => ({
  default: {
    listAssets: vi.fn(async () => []),
    uploadAsset: vi.fn(async () => ({ id: 'lh-1', warning: null })),
    updateAsset: vi.fn(async () => ({})),
    deleteAsset: vi.fn(async () => ({ success: true, message: 'Letterhead deleted.' })),
    assetPreviewUrl: vi.fn(async () => 'blob:preview'),
  },
}));

// The page is wrapped in ProtectedRoute, which needs a resolved session. The
// guard itself is covered by its own spec; here it would only add a login
// fixture to every case.
vi.mock('@/components/auth/ProtectedRoute', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const asset = {
  id: 'lh-1',
  kind: 'LETTERHEAD' as const,
  name: 'Company letter pad',
  scope: 'COMPANY' as const,
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
};

describe('Letterhead page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` resets CALLS but not implementations, so a
    // `mockResolvedValue` set by one case leaks into the next. Every default
    // is restored explicitly rather than relying on ordering.
    (documentTemplateService.listAssets as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (documentTemplateService.uploadAsset as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'lh-1',
      warning: null,
    });
    (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => 'blob:x');
    (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
  });

  it('shows an OBVIOUS upload control, not a bare file input', async () => {
    // The regression this pins: the first version rendered a plain
    // `<input type="file">`, which the browser paints as the words
    // "Choose File — No file chosen". It reads as a caption rather than a
    // control, and the first person to open this screen could not find the
    // upload at all and asked where it was.
    render(<LetterheadPage />);
    expect(await screen.findByTestId('letterhead-dropzone')).toBeTruthy();
    expect(screen.getByText(/Upload your letter pad/i)).toBeTruthy();
    expect(screen.getByText(/Choose an image/i)).toBeTruthy();
    expect(screen.getByText(/drag it here/i)).toBeTruthy();
  });

  it('states the requirements where the person is about to act on them', async () => {
    render(<LetterheadPage />);
    await screen.findByTestId('letterhead-dropzone');
    // The size and the two refused formats — the three things the server will
    // reject an upload for — said BEFORE the upload rather than after it.
    expect(screen.getByText(/1240 × 1754/)).toBeTruthy();
    expect(screen.getByText(/PDF and SVG letterheads are not supported/i)).toBeTruthy();
  });

  it('uploads the chosen file', async () => {
    render(<LetterheadPage />);
    await screen.findByTestId('letterhead-dropzone');
    const file = new File([new Uint8Array([1, 2, 3])], 'pad.png', { type: 'image/png' });
    await userEvent.upload(screen.getByLabelText('Letterhead image'), file);
    await waitFor(() =>
      expect(documentTemplateService.uploadAsset).toHaveBeenCalledWith(
        file,
        expect.objectContaining({ kind: 'LETTERHEAD', scope: 'COMPANY' }),
      ),
    );
  });

  it('shows the server’s refusal rather than failing silently', async () => {
    (documentTemplateService.uploadAsset as ReturnType<typeof vi.fn>).mockRejectedValue({
      message: 'That image is 640×480. A letterhead should be at least 1240×1754.',
    });
    render(<LetterheadPage />);
    await screen.findByTestId('letterhead-dropzone');
    await userEvent.upload(
      screen.getByLabelText('Letterhead image'),
      new File([new Uint8Array([1])], 'small.png', { type: 'image/png' }),
    );
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/640×480/));
  });

  it('surfaces a WARNING without treating it as a failure', async () => {
    // A squarer letter pad is still usable. Refusing it would be the tool
    // overruling the company about its own stationery.
    (documentTemplateService.uploadAsset as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'lh-2',
      warning: 'This image is 1800×1800, which is not A4 proportions.',
    });
    render(<LetterheadPage />);
    await screen.findByTestId('letterhead-dropzone');
    await userEvent.upload(
      screen.getByLabelText('Letterhead image'),
      new File([new Uint8Array([1])], 'square.png', { type: 'image/png' }),
    );
    await waitFor(() => expect(screen.getByText(/not A4 proportions/i)).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('lets the safe area be typed in millimetres', async () => {
    (documentTemplateService.listAssets as ReturnType<typeof vi.fn>).mockResolvedValue([asset]);
    render(<LetterheadPage />);
    const top = await screen.findByLabelText('Top margin in millimetres');
    await userEvent.clear(top);
    await userEvent.type(top, '45');
    await waitFor(() =>
      expect(documentTemplateService.updateAsset).toHaveBeenCalledWith(
        'lh-1',
        expect.objectContaining({ safeTopMm: 45 }),
      ),
    );
  });

  it('says plainly what happens when there is no letterhead', async () => {
    // Matched on the container's text rather than getByText: the sentence is
    // one text node, but asserting on the whole page is what makes this a
    // check that the user CAN READ the explanation, wherever it sits.
    const { container } = render(<LetterheadPage />);
    await waitFor(() => expect(screen.queryByText(/Loading/)).toBeNull());
    expect(container.textContent).toMatch(/header built from your branding/i);
  });
});

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { saveBlob } from './fileDownload';

/**
 * The DOM half of the download helper.
 *
 * A `.test.tsx` rather than `.test.ts` because vitest splits its projects by
 * EXTENSION, not directory: `*.test.ts` runs in the node environment, where
 * `document` does not exist. The pure logic lives in `fileDownload.test.ts`.
 */
describe('saveBlob (DOM)', () => {
  beforeEach(() => {
    // jsdom implements neither of these.
    (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => 'blob:mock');
    (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('clicks a download link and revokes the URL on a delay', () => {
    const click = vi.fn();
    const orig = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = orig(tag);
      if (tag === 'a') (el as HTMLAnchorElement).click = click;
      return el;
    }) as typeof document.createElement);

    saveBlob(new Blob(['x']), 'payslip.pdf');
    expect(click).toHaveBeenCalledTimes(1);

    // Revoking synchronously cancels the download in some browsers before it
    // has started, which is why the delay exists at all.
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock');
  });

  it('leaves no anchor behind in the document', () => {
    saveBlob(new Blob(['x']), 'payslip.pdf');
    expect(document.querySelectorAll('a[download]')).toHaveLength(0);
  });
});

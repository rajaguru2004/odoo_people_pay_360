import { describe, expect, it, vi, beforeEach } from 'vitest';

// `vi.mock` is hoisted above the imports, so the factory cannot close over a
// top-level variable. `vi.hoisted` is the supported way to share one.
const mocks = vi.hoisted(() => ({
  post: vi.fn(async () => ({})),
  get: vi.fn(async () => ({})),
  put: vi.fn(async () => ({})),
  del: vi.fn(async () => ({})),
}));

vi.mock('@/lib/axios', () => ({
  default: { post: mocks.post, get: mocks.get, put: mocks.put, delete: mocks.del },
}));

import documentTemplateService from './documentTemplateService';

describe('documentTemplateService.uploadAsset', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends FormData with a multipart Content-Type', async () => {
    // The regression: `lib/axios.ts` sets `application/json` in the INSTANCE
    // defaults, so axios applies it to a FormData body too. The request then
    // goes out declared as JSON, multer finds no multipart body, and the server
    // answers "No file was uploaded" — with nothing in the log to suggest a
    // file was ever attached. Every other upload in this codebase overrides the
    // header the same way.
    const file = new File([new Uint8Array([1, 2, 3])], 'pad.png', { type: 'image/png' });
    await documentTemplateService.uploadAsset(file, { name: 'Pad', kind: 'LETTERHEAD' });

    expect(mocks.post).toHaveBeenCalledTimes(1);
    const [url, body, config] = mocks.post.mock.calls[0] as unknown as [
      string,
      FormData,
      { headers?: Record<string, string> },
    ];
    expect(url).toBe('/documents/assets');
    expect(body).toBeInstanceOf(FormData);
    expect(config?.headers?.['Content-Type']).toBe('multipart/form-data');
  });

  it('attaches the file under the field name the interceptor expects', async () => {
    // `FileInterceptor('file')` — a different field name is silently ignored
    // and produces the same unhelpful "No file was uploaded".
    const file = new File([new Uint8Array([1])], 'pad.png', { type: 'image/png' });
    await documentTemplateService.uploadAsset(file);
    const body = (mocks.post.mock.calls[0] as unknown[])[1] as FormData;
    expect(body.get('file')).toBeInstanceOf(File);
  });

  it('omits empty optional fields rather than sending blanks', async () => {
    const file = new File([new Uint8Array([1])], 'pad.png', { type: 'image/png' });
    await documentTemplateService.uploadAsset(file, { name: '', kind: 'LETTERHEAD' });
    const body = (mocks.post.mock.calls[0] as unknown[])[1] as FormData;
    expect(body.get('name')).toBeNull();
    expect(body.get('kind')).toBe('LETTERHEAD');
  });

  it('unwraps a blob response, which axios returns whole', async () => {
    // lib/axios.ts returns the ENTIRE AxiosResponse for responseType 'blob'
    // and `response.data` for everything else. Getting this wrong yields an
    // object that looks like a Blob and is not one.
    const blob = new Blob(['%PDF-']);
    mocks.post.mockResolvedValueOnce({ data: blob } as never);
    const out = await documentTemplateService.previewPdf({ typeKey: 'PAYSLIP' });
    expect(out).toBe(blob);
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  FileDownloadError,
  filenameFromResponse,
  saveBlob,
  unwrapBlob,
} from './fileDownload';

describe('filenameFromResponse', () => {
  const withHeader = (value?: string) => ({ headers: value ? { 'content-disposition': value } : {} });

  it('falls back when there is no header at all', () => {
    expect(filenameFromResponse(withHeader(), 'fallback.pdf')).toBe('fallback.pdf');
    expect(filenameFromResponse(undefined, 'fallback.pdf')).toBe('fallback.pdf');
    expect(filenameFromResponse({}, 'fallback.pdf')).toBe('fallback.pdf');
  });

  it('reads a plain quoted filename', () => {
    expect(
      filenameFromResponse(withHeader('attachment; filename="SALARY-2026-00142.pdf"'), 'x.pdf'),
    ).toBe('SALARY-2026-00142.pdf');
  });

  it('reads an unquoted filename', () => {
    expect(filenameFromResponse(withHeader('attachment; filename=report.pdf'), 'x.pdf')).toBe(
      'report.pdf',
    );
  });

  it('prefers the RFC 5987 form, which is the one carrying non-ASCII', () => {
    // The backend emits BOTH, with the plain one degraded to ASCII. Taking the
    // plain one would silently mangle every Arabic and em-dashed filename.
    const header =
      "attachment; filename=\"Salary certificate.pdf\"; filename*=UTF-8''%D8%B4%D9%87%D8%A7%D8%AF%D8%A9.pdf";
    expect(filenameFromResponse(withHeader(header), 'x.pdf')).toBe('شهادة.pdf');
  });

  it('falls back to the plain form when the encoded one is malformed', () => {
    const header = 'attachment; filename="ok.pdf"; filename*=UTF-8\'\'%E0%A4%A.pdf';
    expect(filenameFromResponse(withHeader(header), 'x.pdf')).toBe('ok.pdf');
  });
});

describe('unwrapBlob', () => {
  it('unwraps an AxiosResponse, which is what blob calls return', () => {
    // lib/axios.ts returns the WHOLE response for responseType:'blob' and
    // response.data for everything else. Getting this wrong produced an object
    // that looked like a Blob and was not one.
    const blob = new Blob(['x']);
    expect(unwrapBlob({ data: blob })).toBe(blob);
  });

  it('passes through a bare blob', () => {
    const blob = new Blob(['x']);
    expect(unwrapBlob(blob)).toBe(blob);
  });
});

describe('saveBlob', () => {
  it('THROWS rather than logging when handed something that is not a Blob', () => {
    // The behaviour this replaces called console.error, which fails any
    // Playwright test that touches the path AND told the user nothing about
    // why the download did nothing. This check happens before any DOM access,
    // so it belongs in the node project with the rest of the pure logic.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => saveBlob({ not: 'a blob' }, 'x.pdf')).toThrow(FileDownloadError);
    expect(() => saveBlob(null, 'x.pdf')).toThrow(/did not arrive as a file/);
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { PRIVATE_REF_PREFIX, StorageService } from './storage.service';

/**
 * Local-storage mode only (no MINIO_* config), which is also the fallback path
 * a misconfigured deployment lands on — the one that must not quietly write
 * sensitive files somewhere world-readable.
 */
function makeService(overrides: Record<string, string> = {}) {
  const config = {
    get: (key: string) => overrides[key],
  } as unknown as ConfigService;
  return new StorageService(config);
}

describe('StorageService — private storage', () => {
  let cwd: string;
  let tmp: string;

  beforeEach(() => {
    // The service resolves its directories from process.cwd() at construction.
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-spec-'));
    cwd = process.cwd();
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns an opaque ref, never a URL', async () => {
    const service = makeService();
    const ref = await service.uploadPrivateFile(
      Buffer.from('salary certificate'),
      'cert.pdf',
      'letters',
    );

    expect(ref).toBe(`${PRIVATE_REF_PREFIX}letters/cert.pdf`);
    // The whole point: nothing here can be handed to resolveFileUrl().
    expect(ref).not.toMatch(/^https?:\/\//);
    expect(ref).not.toContain('/uploads/');
    expect(StorageService.isPrivateRef(ref)).toBe(true);
  });

  it('writes outside the statically-served uploads directory', async () => {
    const service = makeService();
    await service.uploadPrivateFile(Buffer.from('passport'), 'p.pdf', 'docs');

    // main.ts serves `uploads/` at /uploads/ with no auth.
    expect(fs.existsSync(path.join(tmp, 'uploads', 'docs', 'p.pdf'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'private-uploads', 'docs', 'p.pdf'))).toBe(
      true,
    );
  });

  it('writes private files owner-only', async () => {
    const service = makeService();
    await service.uploadPrivateFile(Buffer.from('x'), 'p.pdf', 'docs');

    const mode = fs.statSync(path.join(tmp, 'private-uploads', 'docs', 'p.pdf'))
      .mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('round-trips content through readPrivateFile', async () => {
    const service = makeService();
    const ref = await service.uploadPrivateFile(
      Buffer.from('to whom it may concern'),
      'noc.pdf',
      'letters',
    );

    const { buffer, mimeType } = await service.readPrivateFile(ref);
    expect(buffer.toString()).toBe('to whom it may concern');
    expect(mimeType).toBe('application/pdf');
  });

  it('refuses to sign or read a public URL', async () => {
    const service = makeService();
    await expect(
      service.getSignedUrl('https://cdn.example.com/bucket/x.pdf'),
    ).rejects.toThrow(/Not a private storage ref/);
    await expect(service.readPrivateFile('/uploads/docs/x.pdf')).rejects.toThrow(
      /Not a private storage ref/,
    );
  });

  it('has no URL to sign on local storage', async () => {
    const service = makeService();
    const ref = await service.uploadPrivateFile(Buffer.from('x'), 'a.pdf', 'l');
    // Null tells the download route to stream instead of redirecting.
    await expect(service.getSignedUrl(ref)).resolves.toBeNull();
  });

  it('routes deleteFile to private storage for private refs', async () => {
    const service = makeService();
    const ref = await service.uploadPrivateFile(Buffer.from('x'), 'a.pdf', 'l');

    await service.deleteFile(ref);

    expect(fs.existsSync(path.join(tmp, 'private-uploads', 'l', 'a.pdf'))).toBe(
      false,
    );
  });

  it('keeps public uploads on the public path', async () => {
    const service = makeService();
    const url = await service.uploadFile(Buffer.from('avatar'), 'a.png', 'avatars');

    expect(url).toBe('/uploads/avatars/a.png');
    expect(StorageService.isPrivateRef(url)).toBe(false);
  });
});

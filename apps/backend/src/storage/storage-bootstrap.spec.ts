import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { StorageService } from './storage.service';
import { retryWithBackoff, withDeadline } from './minio-bootstrap.util';

/**
 * Regression cover for the boot-time MinIO probe. A slow first answer (boot
 * loads two ML model sets on the same event loop) used to latch the service
 * into local-disk mode for the rest of the process — files written into a
 * container that loses them on redeploy, behind public URLs that 404.
 */
const MINIO_ENV = {
  MINIO_ENDPOINT: 'minio.test',
  MINIO_PORT: '9009',
  MINIO_ACCESS_KEY: 'key',
  MINIO_SECRET_KEY: 'secret',
  MINIO_BUCKET: 'attendance-photos',
  MINIO_INIT_TIMEOUT_MS: '50',
};

function makeService() {
  const config = {
    get: (key: string) => (MINIO_ENV as Record<string, string>)[key],
  } as unknown as ConfigService;
  return new StorageService(config);
}

describe('minio-bootstrap util', () => {
  it('rejects past the deadline and clears its timer on success', async () => {
    jest.useFakeTimers();
    try {
      const slow = withDeadline(
        () => new Promise(() => undefined),
        1000,
        'bucketExists',
      );
      const assertion = expect(slow).rejects.toThrow(
        'bucketExists timed out after 1000ms',
      );
      jest.advanceTimersByTime(1000);
      await assertion;

      await expect(
        withDeadline(async () => 'ok', 1000, 'bucketExists'),
      ).resolves.toBe('ok');
      // The old inline Promise.race leaked one live timer per probe.
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('retries until the operation succeeds', async () => {
    let attempts = 0;
    const result = await retryWithBackoff(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('Connection timeout');
        return 'ready';
      },
      [1, 1],
    );

    expect(result).toBe('ready');
    expect(attempts).toBe(3);
  });

  it('rethrows the last error once attempts are exhausted', async () => {
    await expect(
      retryWithBackoff(async () => {
        throw new Error('ECONNREFUSED');
      }, [1]),
    ).rejects.toThrow('ECONNREFUSED');
  });
});

describe('StorageService — MinIO readiness', () => {
  let cwd: string;
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-boot-'));
    cwd = process.cwd();
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('keeps using MinIO for later uploads after a failed boot probe', async () => {
    const service = makeService();
    const client = (service as any).minioClient;

    // Probe fails: MinIO unreachable. (The boot path wraps this same call in
    // the retry schedule; `ensureReady` is the single-attempt request-path
    // version, so the test does not sit through the backoff.)
    jest.spyOn(client, 'bucketExists').mockRejectedValue(new Error('ETIMEDOUT'));
    await (service as any).ensureReady(false);

    expect(service.getStorageType()).toBe('minio');
    expect(service.isMinioReady()).toBe(false);

    // MinIO comes back. The next upload must go to the bucket, not local disk.
    (client.bucketExists as jest.Mock).mockResolvedValue(true);
    jest.spyOn(client, 'setBucketPolicy').mockResolvedValue(undefined);
    const putObject = jest
      .spyOn(client, 'putObject')
      .mockResolvedValue(undefined as never);

    const url = await service.uploadFile(
      Buffer.from('photo'),
      'a.png',
      'avatars',
    );

    expect(putObject).toHaveBeenCalledWith(
      'attendance-photos',
      'avatars/a.png',
      expect.any(Buffer),
      5,
      { 'Content-Type': 'image/png' },
    );
    expect(url).toBe('http://minio.test:9009/attendance-photos/avatars/a.png');
    expect(fs.existsSync(path.join(tmp, 'uploads', 'avatars', 'a.png'))).toBe(
      false,
    );
  }, 15000);

  it('falls back to local disk for that one request while MinIO is down', async () => {
    const service = makeService();
    const client = (service as any).minioClient;
    jest.spyOn(client, 'bucketExists').mockRejectedValue(new Error('ETIMEDOUT'));
    jest.spyOn(client, 'putObject').mockRejectedValue(new Error('ETIMEDOUT'));

    const url = await service.uploadFile(
      Buffer.from('photo'),
      'b.png',
      'avatars',
    );

    expect(url).toBe('/uploads/avatars/b.png');
    // Still MinIO-backed for the next request — no permanent downgrade.
    expect(service.getStorageType()).toBe('minio');
  }, 15000);
});

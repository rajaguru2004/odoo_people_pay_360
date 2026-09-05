import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import * as Minio from 'minio';
import {
  BUCKET_RETRY_DELAYS_MS,
  retryWithBackoff,
  withDeadline,
} from './minio-bootstrap.util';

/**
 * Storage Service - Supports both MinIO Storage and Local Storage
 * Automatically uses MinIO if credentials are configured, otherwise falls back to local
 */
/**
 * Marker for an object in the PRIVATE bucket.
 *
 * Deliberately not a URL. The public bucket's contents are world-readable by
 * link, and `resolveFileUrl()` on the frontend will happily render any URL it
 * is given — so a private object must never be representable as one. Anything
 * holding a `private://` ref has to go through the authenticated download
 * route, because there is nothing else it can do with it.
 */
export const PRIVATE_REF_PREFIX = 'private://';

/** Deadline for the bucket probe done on the upload path, where a user waits. */
const UPLOAD_PROBE_TIMEOUT_MS = 5000;

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly uploadDir = path.join(process.cwd(), 'uploads');
  /** Outside `uploads/`, which main.ts serves statically at /uploads/. */
  private readonly privateUploadDir = path.join(process.cwd(), 'private-uploads');
  private minioClient: Minio.Client;
  private useMinio: boolean;
  private readonly bucketName: string;
  private readonly privateBucketName: string;
  private readonly initTimeoutMs: number;
  /** Bucket verified this process. Not "MinIO is configured" — see `useMinio`. */
  private bucketReady = false;
  private privateBucketReady = false;
  /** In-flight verification, so N concurrent uploads trigger one probe. */
  private bucketReadyPromise: Promise<void> | null = null;
  private privateBucketReadyPromise: Promise<void> | null = null;
  /** In-flight request-path probes, keyed 'public' | 'private'. */
  private readonly uploadProbes = new Map<string, Promise<void>>();

  async onModuleInit() {
    if (!this.useMinio) return;

    // Detached and retried, never awaited. Boot is the worst moment to probe
    // the network — the embedding and face-api model loads run in this same
    // window — so a single short-deadline probe here reported "storage down"
    // for a MinIO that was up the whole time.
    void this.verifyBucket().catch(() => undefined);
    void this.verifyPrivateBucket().catch(() => undefined);
  }

  /** Verify the public bucket with retries; safe to call concurrently. */
  private verifyBucket(): Promise<void> {
    if (this.bucketReady) return Promise.resolve();
    if (this.bucketReadyPromise) return this.bucketReadyPromise;

    this.bucketReadyPromise = retryWithBackoff(
      () => this.ensureBucketExists(),
      BUCKET_RETRY_DELAYS_MS,
      (attempt, err, waitMs) =>
        this.logger.warn(
          `MinIO bucket '${this.bucketName}' check failed (attempt ${attempt}): ${err.message}. Retrying in ${waitMs}ms`,
        ),
    )
      .then(() => {
        this.bucketReady = true;
      })
      .catch((err) => {
        // Deliberately does NOT flip `useMinio`. A failed probe means "not
        // verified yet", not "use local disk forever": latching it sent every
        // later upload to container-local disk, which is lost on redeploy and
        // serves 404s behind the public URL.
        this.logger.error(
          `MinIO bucket '${this.bucketName}' unavailable after retries: ${err.message}. Uploads will retry MinIO and fall back to local disk per request.`,
        );
        throw err;
      })
      .finally(() => {
        this.bucketReadyPromise = null;
      });

    return this.bucketReadyPromise;
  }

  private verifyPrivateBucket(): Promise<void> {
    if (this.privateBucketReady) return Promise.resolve();
    if (this.privateBucketReadyPromise) return this.privateBucketReadyPromise;

    this.privateBucketReadyPromise = retryWithBackoff(
      () => this.ensurePrivateBucketExists(),
      BUCKET_RETRY_DELAYS_MS,
      (attempt, err, waitMs) =>
        this.logger.warn(
          `MinIO private bucket '${this.privateBucketName}' check failed (attempt ${attempt}): ${err.message}. Retrying in ${waitMs}ms`,
        ),
    )
      .then(() => {
        this.privateBucketReady = true;
      })
      .catch((err) => {
        this.logger.error(
          `MinIO private bucket '${this.privateBucketName}' unavailable after retries: ${err.message}`,
        );
        throw err;
      })
      .finally(() => {
        this.privateBucketReadyPromise = null;
      });

    return this.privateBucketReadyPromise;
  }

  /**
   * Best-effort verification before an upload, so the first write after MinIO
   * comes back re-creates/verifies the bucket instead of failing on
   * NoSuchBucket. One attempt on a short deadline — a request must never wait
   * out the boot backoff schedule; if it fails, `putObject` errors and the
   * caller falls back to local disk for that request only.
   */
  private async ensureReady(privateBucket: boolean): Promise<void> {
    if (privateBucket ? this.privateBucketReady : this.bucketReady) return;

    const key = privateBucket ? 'private' : 'public';
    let inflight = this.uploadProbes.get(key);
    if (!inflight) {
      inflight = withDeadline(
        () =>
          privateBucket
            ? this.ensurePrivateBucketExists()
            : this.ensureBucketExists(),
        UPLOAD_PROBE_TIMEOUT_MS,
        'bucket probe',
      )
        .then(() => {
          if (privateBucket) this.privateBucketReady = true;
          else this.bucketReady = true;
        })
        .catch(() => undefined)
        .finally(() => this.uploadProbes.delete(key));
      this.uploadProbes.set(key, inflight);
    }
    await inflight;
  }

  /**
   * Create the private bucket if absent. Unlike `ensureBucketExists`, this sets
   * NO bucket policy — the default (deny) is the point. Access is only ever via
   * a short-lived presigned URL minted after an authorization check.
   */
  private async ensurePrivateBucketExists(): Promise<void> {
    const exists = await withDeadline(
      () => this.minioClient.bucketExists(this.privateBucketName),
      this.initTimeoutMs,
      'bucketExists',
    );
    if (!exists) {
      await withDeadline(
        () => this.minioClient.makeBucket(this.privateBucketName, 'us-east-1'),
        this.initTimeoutMs,
        'makeBucket',
      );
      this.logger.log(`Created private bucket '${this.privateBucketName}'`);
    }
    this.logger.log(
      `🔒 MinIO private bucket ready: '${this.privateBucketName}' (no public policy)`,
    );
  }

  private async ensureBucketExists(): Promise<void> {
    const endPoint = this.configService.get<string>('MINIO_ENDPOINT');
    const port = this.configService.get<string>('MINIO_PORT');

    const exists = await withDeadline(
      () => this.minioClient.bucketExists(this.bucketName),
      this.initTimeoutMs,
      'bucketExists',
    );

    this.logger.log(
      `📡 MinIO S3 connection verified successfully at ${endPoint}:${port}`,
    );

    if (!exists) {
      this.logger.log(
        `Bucket '${this.bucketName}' does not exist. Creating it...`,
      );
      await withDeadline(
        () => this.minioClient.makeBucket(this.bucketName, 'us-east-1'),
        this.initTimeoutMs,
        'makeBucket',
      );
    }

    // Ensure public read policy so uploaded files are publicly accessible.
    // A policy failure is logged but not fatal: the bucket itself answered, so
    // reads/writes work — only the anonymous-GET grant is in doubt.
    const policy = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: '*',
          Action: ['s3:GetObject'],
          Resource: [`arn:aws:s3:::${this.bucketName}/*`],
        },
      ],
    };
    try {
      await withDeadline(
        () =>
          this.minioClient.setBucketPolicy(
            this.bucketName,
            JSON.stringify(policy),
          ),
        this.initTimeoutMs,
        'setBucketPolicy',
      );
      this.logger.log(
        `🔓 MinIO public read policy set/verified for bucket '${this.bucketName}'`,
      );
    } catch (err) {
      this.logger.warn(
        `Could not set public read policy on '${this.bucketName}': ${
          err instanceof Error ? err.message : String(err)
        }. Uploads still work; public URLs may 403.`,
      );
    }
  }

  constructor(private configService: ConfigService) {
    // Initialize local storage
    if (!fs.existsSync(this.uploadDir)) {
      fs.mkdirSync(this.uploadDir, { recursive: true });
      this.logger.log(`Created upload directory: ${this.uploadDir}`);
    }

    // Check if MinIO is configured
    const endPoint = this.configService.get<string>('MINIO_ENDPOINT');
    const portStr = this.configService.get<string>('MINIO_PORT');
    const port = parseInt(portStr ?? '', 10) || 443;
    const useSSL = this.configService.get<string>('MINIO_USE_SSL') === 'true';
    const accessKey = this.configService.get<string>('MINIO_ACCESS_KEY');
    const secretKey = this.configService.get<string>('MINIO_SECRET_KEY');
    this.bucketName =
      this.configService.get<string>('MINIO_BUCKET') || 'attendance-photos';
    this.privateBucketName =
      this.configService.get<string>('MINIO_PRIVATE_BUCKET') ||
      `${this.bucketName}-private`;

    this.useMinio = !!(endPoint && accessKey && secretKey);
    // 3s was measured against a boot that also loads two ML model sets; raise
    // it and let MINIO_INIT_TIMEOUT_MS tune it per environment.
    this.initTimeoutMs =
      parseInt(
        this.configService.get<string>('MINIO_INIT_TIMEOUT_MS') ?? '',
        10,
      ) || 15000;

    if (this.useMinio) {
      this.minioClient = new Minio.Client({
        endPoint: endPoint!,
        port,
        useSSL,
        accessKey: accessKey!,
        secretKey: secretKey!,
      });
      this.logger.log(
        `✅ MinIO Storage client initialized (Endpoint: ${endPoint}:${port}, SSL: ${useSSL}, Bucket: ${this.bucketName})`,
      );
    } else {
      this.logger.log('📁 Using local file storage (MinIO not configured)');
    }
  }

  private getPublicUrl(fileName: string): string {
    // Inside Docker, MINIO_ENDPOINT is the compose service name ('minio:9000'),
    // which no browser can resolve. MINIO_PUBLIC_URL is the address the outside
    // world uses; without it the stored URLs are dead links.
    const publicBase = this.configService
      .get<string>('MINIO_PUBLIC_URL')
      ?.replace(/\/+$/, '');
    if (publicBase) {
      return `${publicBase}/${this.bucketName}/${fileName}`;
    }

    const protocol =
      this.configService.get<string>('MINIO_USE_SSL') === 'true'
        ? 'https'
        : 'http';
    const endPoint = this.configService.get<string>('MINIO_ENDPOINT') ?? '';
    const port = this.configService.get<string>('MINIO_PORT');
    const portStr = port === '80' || port === '443' || !port ? '' : `:${port}`;
    return `${protocol}://${endPoint}${portStr}/${this.bucketName}/${fileName}`;
  }

  /**
   * Upload file to storage (MinIO or local)
   * @param file - File buffer
   * @param fileName - File name
   * @param folder - Subfolder (e.g., 'avatars', 'documents')
   * @returns File URL
   */
  async uploadFile(
    file: Buffer,
    fileName: string,
    folder: string = 'documents',
  ): Promise<string> {
    if (this.useMinio) {
      return this.uploadToMinio(file, fileName, folder);
    } else {
      return this.uploadToLocal(file, fileName, folder);
    }
  }

  /**
   * Upload to MinIO Storage
   */
  private async uploadToMinio(
    file: Buffer,
    fileName: string,
    folder: string,
  ): Promise<string> {
    try {
      const filePath = `${folder}/${fileName}`;

      await this.ensureReady(false);
      await this.minioClient.putObject(
        this.bucketName,
        filePath,
        file,
        file.length,
        { 'Content-Type': this.getMimeType(fileName) },
      );

      const fileUrl = this.getPublicUrl(filePath);
      this.logger.log(`File uploaded to MinIO: ${fileUrl}`);
      return fileUrl;
    } catch (error) {
      this.logger.error(`Failed to upload to MinIO: ${error.message}`);
      // Fallback to local storage
      this.logger.warn('Falling back to local storage');
      return this.uploadToLocal(file, fileName, folder);
    }
  }

  /**
   * Upload to local storage
   */
  private async uploadToLocal(
    file: Buffer,
    fileName: string,
    folder: string,
  ): Promise<string> {
    try {
      // Create folder if not exists
      const folderPath = path.join(this.uploadDir, folder);
      if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true });
      }

      // Save file
      const filePath = path.join(folderPath, fileName);
      fs.writeFileSync(filePath, file);

      // Return relative URL
      const fileUrl = `/uploads/${folder}/${fileName}`;
      this.logger.log(`File uploaded locally: ${fileUrl}`);

      return fileUrl;
    } catch (error) {
      this.logger.error(`Failed to upload locally: ${error.message}`);
      throw error;
    }
  }

  // ── Private storage ────────────────────────────────────────────────────────
  //
  // For anything that must not be readable by URL alone: salary certificates,
  // passports, grievance attachments, generated letters. The public bucket has
  // an allow-all `s3:GetObject` policy (see ensureBucketExists), so "unguessable
  // filename" is the only thing protecting objects there — which is not
  // protection.

  static isPrivateRef(ref: string | null | undefined): boolean {
    return typeof ref === 'string' && ref.startsWith(PRIVATE_REF_PREFIX);
  }

  /**
   * Store a file privately.
   *
   * @returns an opaque `private://folder/name` ref to persist. It is NOT a URL
   *          and must be resolved through `getSignedUrl` or `readPrivate`.
   */
  async uploadPrivateFile(
    file: Buffer,
    fileName: string,
    folder: string = 'documents',
  ): Promise<string> {
    const objectPath = `${folder}/${fileName}`;

    if (this.useMinio) {
      try {
        await this.ensureReady(true);
        await this.minioClient.putObject(
          this.privateBucketName,
          objectPath,
          file,
          file.length,
          { 'Content-Type': this.getMimeType(fileName) },
        );
        this.logger.log(`File uploaded to private bucket: ${objectPath}`);
        return `${PRIVATE_REF_PREFIX}${objectPath}`;
      } catch (error) {
        // Note the difference from uploadFile: no fallback to the PUBLIC local
        // path. A private upload that cannot be stored privately must fail.
        this.logger.error(
          `Failed to upload to private bucket: ${error.message}`,
        );
      }
    }

    const folderPath = path.join(this.privateUploadDir, folder);
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(path.join(folderPath, fileName), file, { mode: 0o600 });
    this.logger.log(`File uploaded to private local storage: ${objectPath}`);
    return `${PRIVATE_REF_PREFIX}${objectPath}`;
  }

  /**
   * Short-lived presigned GET for a private object, or null when running on
   * local storage (no object store to sign against — stream via `readPrivate`).
   */
  async getSignedUrl(ref: string, ttlSeconds = 300): Promise<string | null> {
    if (!StorageService.isPrivateRef(ref)) {
      throw new Error(`Not a private storage ref: ${ref}`);
    }
    if (!this.useMinio) return null;

    const objectPath = ref.slice(PRIVATE_REF_PREFIX.length);

    // A ref can point at local disk even while MinIO is configured, because
    // `uploadPrivateFile` falls back on write. Presigning that blindly hands
    // back a URL that 404s; null routes the caller to `readPrivateFile`, which
    // checks both places.
    try {
      await this.minioClient.statObject(this.privateBucketName, objectPath);
    } catch {
      return null;
    }

    return this.minioClient.presignedGetObject(
      this.privateBucketName,
      objectPath,
      ttlSeconds,
    );
  }

  /**
   * Read a PUBLIC object back into memory by the URL we stored for it.
   *
   * Exists for the PDF renderer, which runs on a page with no network access
   * at all: a `<img src="https://minio/...">` in a document silently never
   * paints, which is exactly why the company logo has never appeared on a
   * single issued letter. The bytes have to be inlined as a `data:` URI, and
   * fetching them over HTTP to do that would be this process asking the
   * network for a file it already owns — slower, and one more thing that can
   * be down or firewalled at render time.
   *
   * Returns null rather than throwing: a missing logo must degrade to a
   * letter without a logo, never to a letter that could not be issued.
   */
  async readPublicObject(
    fileUrl: string,
  ): Promise<{ buffer: Buffer; mimeType: string } | null> {
    if (!fileUrl) return null;
    if (StorageService.isPrivateRef(fileUrl)) return null;

    const bucketPrefix = `${this.bucketName}/`;
    if (this.useMinio && fileUrl.includes(bucketPrefix)) {
      // Same URL→object-path extraction as deleteFromMinio, so an object this
      // service can delete is always one it can also read.
      const objectPath = fileUrl.split(bucketPrefix)[1];
      try {
        const stream = await this.minioClient.getObject(
          this.bucketName,
          objectPath,
        );
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(chunk as Buffer);
        return {
          buffer: Buffer.concat(chunks),
          mimeType: this.getMimeType(objectPath),
        };
      } catch (err) {
        this.logger.warn(
          `Public read from MinIO failed for ${objectPath}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return null;
      }
    }

    // Local-disk fallback: main.ts serves process.cwd()/uploads at /uploads/,
    // so a stored URL of that shape is a path relative to the working dir.
    // Anything that escapes it is refused — this takes a value out of a
    // settings row an admin can edit.
    try {
      const relative = fileUrl.replace(/^https?:\/\/[^/]+/, '');
      if (!relative.startsWith('/uploads/')) return null;
      const resolved = path.resolve(process.cwd(), `.${relative}`);
      if (!resolved.startsWith(this.uploadDir + path.sep)) return null;
      if (!fs.existsSync(resolved)) return null;
      return {
        buffer: fs.readFileSync(resolved),
        mimeType: this.getMimeType(resolved),
      };
    } catch {
      return null;
    }
  }

  /** Read a private object into memory, for streaming through an authenticated route. */
  async readPrivateFile(ref: string): Promise<{ buffer: Buffer; mimeType: string }> {
    if (!StorageService.isPrivateRef(ref)) {
      throw new Error(`Not a private storage ref: ${ref}`);
    }
    const objectPath = ref.slice(PRIVATE_REF_PREFIX.length);
    const mimeType = this.getMimeType(objectPath);

    // Read mirrors write. `uploadPrivateFile` falls back to local disk when
    // MinIO is unreachable, so a ref can legitimately point at either place —
    // reading only from the bucket turned "written locally" into an opaque 500.
    let minioError: unknown;
    if (this.useMinio) {
      try {
        const stream = await this.minioClient.getObject(
          this.privateBucketName,
          objectPath,
        );
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(chunk as Buffer);
        return { buffer: Buffer.concat(chunks), mimeType };
      } catch (err) {
        minioError = err;
        this.logger.warn(
          `Private read from MinIO failed for ${objectPath} (${
            err instanceof Error ? err.message : String(err)
          }); trying local storage`,
        );
      }
    }

    const filePath = path.join(this.privateUploadDir, objectPath);
    if (fs.existsSync(filePath)) {
      return { buffer: fs.readFileSync(filePath), mimeType };
    }

    // Name the real cause. A bare "not found" here sends whoever debugs it
    // looking for a missing row rather than a misconfigured bucket.
    throw new Error(
      `Private file not found: ${objectPath}` +
        (minioError
          ? ` — MinIO bucket "${this.privateBucketName}": ${
              minioError instanceof Error ? minioError.message : String(minioError)
            }`
          : ''),
    );
  }

  async deletePrivateFile(ref: string): Promise<void> {
    if (!StorageService.isPrivateRef(ref)) return;
    const objectPath = ref.slice(PRIVATE_REF_PREFIX.length);
    try {
      if (this.useMinio) {
        await this.minioClient.removeObject(this.privateBucketName, objectPath);
      } else {
        const filePath = path.join(this.privateUploadDir, objectPath);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
      this.logger.log(`Private file deleted: ${objectPath}`);
    } catch (error) {
      this.logger.error(`Failed to delete private file: ${error.message}`);
    }
  }

  /**
   * Delete file from storage
   * @param fileUrl - File URL to delete
   */
  async deleteFile(fileUrl: string): Promise<void> {
    if (StorageService.isPrivateRef(fileUrl)) {
      await this.deletePrivateFile(fileUrl);
    } else if (this.useMinio && fileUrl.includes(this.bucketName)) {
      await this.deleteFromMinio(fileUrl);
    } else {
      await this.deleteFromLocal(fileUrl);
    }
  }

  /**
   * Delete from MinIO Storage
   */
  private async deleteFromMinio(fileUrl: string): Promise<void> {
    try {
      const bucketPrefix = `${this.bucketName}/`;
      let path = fileUrl;

      // Extract path from full URL
      if (fileUrl.includes(bucketPrefix)) {
        path = fileUrl.split(bucketPrefix)[1];
      }

      await this.minioClient.removeObject(this.bucketName, path);
      this.logger.log(`File deleted from MinIO: ${path}`);
    } catch (error) {
      this.logger.error(`Failed to delete from MinIO: ${error.message}`);
    }
  }

  /**
   * Delete from local storage
   */
  private async deleteFromLocal(fileUrl: string): Promise<void> {
    try {
      const filePath = path.join(process.cwd(), fileUrl);

      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        this.logger.log(`File deleted locally: ${fileUrl}`);
      }
    } catch (error) {
      this.logger.error(`Failed to delete locally: ${error.message}`);
    }
  }

  /**
   * Get file path from URL (for local storage)
   * @param fileUrl - File URL
   * @returns Absolute file path
   */
  getFilePath(fileUrl: string): string {
    return path.join(process.cwd(), fileUrl);
  }

  /**
   * Check if file exists (for local storage)
   * @param fileUrl - File URL
   * @returns True if file exists
   */
  fileExists(fileUrl: string): boolean {
    if (this.useMinio && fileUrl.includes(this.bucketName)) {
      // For MinIO, assume file exists if URL is valid (this is an approximation, ideally we would headObject)
      return true;
    }
    const filePath = this.getFilePath(fileUrl);
    return fs.existsSync(filePath);
  }

  /**
   * Get storage type
   */
  getStorageType(): 'minio' | 'local' {
    return this.useMinio ? 'minio' : 'local';
  }

  /** Configured AND verified this process — for health endpoints/diagnostics. */
  isMinioReady(): boolean {
    return this.useMinio && this.bucketReady;
  }

  /**
   * Get MIME type from file name
   */
  private getMimeType(fileName: string): string {
    const ext = path.extname(fileName).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      // The company logo can be an SVG (upload.service.ts accepts image/svg+xml).
      // Without this it read back as application/octet-stream, which is not a
      // type a `data:` URI in an <img> will render.
      '.svg': 'image/svg+xml',
      '.pdf': 'application/pdf',
      '.doc': 'application/msword',
      '.docx':
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }
}

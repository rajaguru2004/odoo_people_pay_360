import {
  Injectable,
  BadRequestException,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Minio from 'minio';
import * as crypto from 'crypto';
import sharp from 'sharp';
import axios from 'axios';
import {
  BUCKET_RETRY_DELAYS_MS,
  retryWithBackoff,
  withDeadline,
} from '../storage/minio-bootstrap.util';

/** Deadline for the bucket probe done on the upload path, where a user waits. */
const UPLOAD_PROBE_TIMEOUT_MS = 5000;

@Injectable()
export class UploadService implements OnModuleInit {
  private readonly logger = new Logger(UploadService.name);
  private minioClient?: Minio.Client;
  private bucketName: string;
  private readonly initTimeoutMs: number;
  private bucketReady = false;
  private bucketReadyPromise: Promise<void> | null = null;
  private uploadProbe: Promise<void> | null = null;

  async onModuleInit() {
    if (!this.minioClient) return;
    // Detached and retried — see storage/minio-bootstrap.util.ts for why one
    // short probe at boot is not a reliable measurement.
    void this.verifyBucket().catch(() => undefined);
  }

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
        this.logger.error(
          `MinIO bucket '${this.bucketName}' unavailable after retries: ${err.message}`,
        );
        throw err;
      })
      .finally(() => {
        this.bucketReadyPromise = null;
      });

    return this.bucketReadyPromise;
  }

  /**
   * Resolve the client for a write, verifying the bucket first so the upload
   * after a MinIO restart re-creates it instead of failing on NoSuchBucket.
   */
  private async client(): Promise<Minio.Client> {
    if (!this.minioClient) {
      throw new ServiceUnavailableException(
        'File storage is not configured (MINIO_ENDPOINT / MINIO_ACCESS_KEY / MINIO_SECRET_KEY)',
      );
    }
    if (!this.bucketReady) {
      // One attempt on a short deadline — a request must not wait out the boot
      // backoff schedule. On failure the putObject below reports the real error.
      this.uploadProbe ??= withDeadline(
        () => this.ensureBucketExists(),
        UPLOAD_PROBE_TIMEOUT_MS,
        'bucket probe',
      )
        .then(() => {
          this.bucketReady = true;
        })
        .catch(() => undefined)
        .finally(() => {
          this.uploadProbe = null;
        });
      await this.uploadProbe;
    }
    return this.minioClient;
  }

  private async ensureBucketExists(): Promise<void> {
    const minio = this.minioClient!;
    const exists = await withDeadline(
      () => minio.bucketExists(this.bucketName),
      this.initTimeoutMs,
      'bucketExists',
    );

    if (!exists) {
      this.logger.log(
        `Bucket '${this.bucketName}' does not exist. Creating it...`,
      );
      await withDeadline(
        () => minio.makeBucket(this.bucketName, 'us-east-1'),
        this.initTimeoutMs,
        'makeBucket',
      );

      // Set public read policy so uploaded files are publicly accessible
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
      await withDeadline(
        () => minio.setBucketPolicy(this.bucketName, JSON.stringify(policy)),
        this.initTimeoutMs,
        'setBucketPolicy',
      );
      this.logger.log(`Public read policy set for bucket '${this.bucketName}'`);
    }
    this.logger.log(`📡 MinIO bucket ready: '${this.bucketName}'`);
  }

  constructor(private configService: ConfigService) {
    const endPoint = this.configService.get<string>('MINIO_ENDPOINT');
    const portStr = this.configService.get<string>('MINIO_PORT');
    const port = parseInt(portStr ?? '', 10) || 443;
    const useSSL = this.configService.get<string>('MINIO_USE_SSL') === 'true';
    const accessKey = this.configService.get<string>('MINIO_ACCESS_KEY');
    const secretKey = this.configService.get<string>('MINIO_SECRET_KEY');
    this.bucketName =
      this.configService.get<string>('MINIO_BUCKET') || 'attendance-photos';
    this.initTimeoutMs =
      parseInt(
        this.configService.get<string>('MINIO_INIT_TIMEOUT_MS') ?? '',
        10,
      ) || 15000;

    if (!endPoint || !accessKey || !secretKey) {
      // Logged, not thrown: this used to abort Nest bootstrap, taking down
      // payroll, leave and attendance because a logo upload had no bucket.
      // Upload routes now fail on their own with 503.
      this.logger.error(
        'MinIO credentials not configured — upload endpoints will return 503',
      );
      return;
    }

    this.minioClient = new Minio.Client({
      endPoint: endPoint,
      port,
      useSSL,
      accessKey: accessKey,
      secretKey: secretKey,
    });
  }

  private getPublicUrl(fileName: string): string {
    // See StorageService.getPublicUrl — MINIO_ENDPOINT is the internal address
    // ('minio:9000' in Docker); MINIO_PUBLIC_URL is what a browser can fetch.
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
   * Upload logo. Also rasterizes a 64×64 PNG favicon from the same image and
   * stores it in MinIO. Returns both public URLs.
   */
  async uploadLogo(
    file: Express.Multer.File,
  ): Promise<{ url: string; faviconUrl: string }> {
    this.validateImageFile(file);

    const fileExt = file.originalname.split('.').pop();
    const fileName = `logo/company_logo_${Date.now()}.${fileExt}`;

    try {
      const minio = await this.client();
      await minio.putObject(
        this.bucketName,
        fileName,
        file.buffer,
        file.size,
        { 'Content-Type': file.mimetype },
      );

      const url = this.getPublicUrl(fileName);
      const faviconUrl = await this.generateFaviconFromBuffer(
        file.buffer,
        file.mimetype === 'image/svg+xml',
      );

      return { url, faviconUrl };
    } catch (error) {
      this.logger.error(`Logo upload failed: ${error.message}`);
      throw new BadRequestException(`Upload failed: ${error.message}`);
    }
  }

  /**
   * Rasterize an image buffer into a 64×64 PNG favicon and store it in MinIO.
   *
   * The object key is derived from the content hash, so identical input always
   * maps to the same URL (cheap idempotent re-saves) and any change produces a
   * new URL — giving natural cache-busting without query-string timestamps.
   * Returns '' on failure so callers can fall back gracefully.
   */
  async generateFaviconFromBuffer(
    buffer: Buffer,
    isSvg: boolean,
  ): Promise<string> {
    try {
      const png = await sharp(buffer, isSvg ? { density: 384 } : undefined)
        .resize(64, 64, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png()
        .toBuffer();

      const hash = crypto
        .createHash('sha1')
        .update(png)
        .digest('hex')
        .slice(0, 12);
      const faviconName = `logo/favicon-${hash}.png`;

      const minio = await this.client();
      await minio.putObject(
        this.bucketName,
        faviconName,
        png,
        png.length,
        { 'Content-Type': 'image/png' },
      );

      return this.getPublicUrl(faviconName);
    } catch (error) {
      this.logger.error(`Favicon generation failed: ${error.message}`);
      return '';
    }
  }

  /** Generate a favicon from a raw SVG string. */
  async generateFaviconFromSvg(svgContent: string): Promise<string> {
    if (!svgContent || !svgContent.trim()) return '';
    return this.generateFaviconFromBuffer(Buffer.from(svgContent), true);
  }

  /** Fetch an image by URL and generate a favicon from it. */
  async generateFaviconFromUrl(url: string): Promise<string> {
    if (!url || !url.trim()) return '';
    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 8000,
      });
      const contentType: string = response.headers['content-type'] || '';
      const isSvg =
        contentType.includes('svg') || url.toLowerCase().endsWith('.svg');
      return this.generateFaviconFromBuffer(Buffer.from(response.data), isSvg);
    } catch (error) {
      this.logger.error(`Favicon fetch from URL failed: ${error.message}`);
      return '';
    }
  }

  /**
   * Folders a caller may upload an unattached file into.
   *
   * An allowlist rather than sanitisation: the folder becomes part of the object
   * key, and "reject what is not on the list" cannot be talked into escaping the
   * prefix the way an escaping rule can.
   */
  private static readonly PUBLIC_FOLDERS = ['profile', 'documents'] as const;

  /**
   * Upload a file that is not yet attached to any record, returning its URL.
   *
   * Exists because a template FILE field (an employee photo, a scanned permit)
   * has to be filled in on the CREATE form, before the employee it belongs to
   * has an id — the entity-scoped routes above cannot serve that, which is why
   * such fields used to be a bare "paste a URL" text box.
   */
  async uploadPublicFile(
    folder: string,
    file: Express.Multer.File,
  ): Promise<string> {
    const target = (folder || 'profile').toLowerCase();
    if (!(UploadService.PUBLIC_FOLDERS as readonly string[]).includes(target)) {
      throw new BadRequestException(
        `folder must be one of: ${UploadService.PUBLIC_FOLDERS.join(', ')}`,
      );
    }

    if (target === 'profile') {
      this.validateImageFile(file);
    } else {
      this.validateDocumentFile(file);
    }

    // Content-addressed: re-uploading the same image reuses one object instead
    // of littering the bucket, and a changed image always gets a fresh URL.
    const hash = crypto
      .createHash('sha1')
      .update(file.buffer)
      .digest('hex')
      .slice(0, 16);
    const ext = (file.originalname.split('.').pop() ?? 'bin')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 8);
    const fileName = `${target}/${hash}.${ext || 'bin'}`;

    try {
      // Must go through client(): it raises a 503 when storage is unconfigured
      // and re-verifies the bucket, so an upload after a MinIO restart recreates
      // it instead of failing on NoSuchBucket. Touching this.minioClient
      // directly would be a TypeError on an unconfigured instance.
      const minio = await this.client();
      await minio.putObject(
        this.bucketName,
        fileName,
        file.buffer,
        file.size,
        { 'Content-Type': file.mimetype },
      );
      return this.getPublicUrl(fileName);
    } catch (error) {
      this.logger.error(`File upload failed: ${error.message}`);
      throw new BadRequestException(`Upload failed: ${error.message}`);
    }
  }

  /**
   * Upload employee avatar
   */
  async uploadAvatar(
    employeeId: string,
    file: Express.Multer.File,
  ): Promise<string> {
    this.validateImageFile(file);

    const fileExt = file.originalname.split('.').pop();
    const fileName = `avatars/${employeeId}.${fileExt}`;

    try {
      const minio = await this.client();
      await minio.putObject(
        this.bucketName,
        fileName,
        file.buffer,
        file.size,
        { 'Content-Type': file.mimetype },
      );

      return this.getPublicUrl(fileName);
    } catch (error) {
      this.logger.error(`Avatar upload failed: ${error.message}`);
      throw new BadRequestException(`Upload failed: ${error.message}`);
    }
  }

  /**
   * Upload contract document
   */
  async uploadContract(
    contractId: string,
    file: Express.Multer.File,
  ): Promise<string> {
    this.validatePdfFile(file);

    const fileExt = file.originalname.split('.').pop();
    const fileName = `contracts/${contractId}.${fileExt}`;

    try {
      const minio = await this.client();
      await minio.putObject(
        this.bucketName,
        fileName,
        file.buffer,
        file.size,
        { 'Content-Type': file.mimetype },
      );

      return this.getPublicUrl(fileName);
    } catch (error) {
      this.logger.error(`Contract upload failed: ${error.message}`);
      throw new BadRequestException(`Upload failed: ${error.message}`);
    }
  }

  /**
   * Upload general document (certificate, degree, etc.)
   */
  async uploadDocument(
    employeeId: string,
    category: string,
    file: Express.Multer.File,
  ): Promise<string> {
    this.validateDocumentFile(file);

    const timestamp = Date.now();
    const fileExt = file.originalname.split('.').pop();
    const fileName = `documents/${employeeId}/${category}/${timestamp}.${fileExt}`;

    try {
      const minio = await this.client();
      await minio.putObject(
        this.bucketName,
        fileName,
        file.buffer,
        file.size,
        { 'Content-Type': file.mimetype },
      );

      return this.getPublicUrl(fileName);
    } catch (error) {
      this.logger.error(`Document upload failed: ${error.message}`);
      throw new BadRequestException(`Upload failed: ${error.message}`);
    }
  }

  /**
   * Delete file from storage
   */
  async deleteFile(filePath: string): Promise<void> {
    const bucketPrefix = `${this.bucketName}/`;
    let path = filePath;

    // Extract path from full URL if passed
    if (filePath.includes(bucketPrefix)) {
      path = filePath.split(bucketPrefix)[1];
    }

    if (!path) {
      throw new BadRequestException('Invalid file path');
    }

    try {
      const minio = await this.client();
      await minio.removeObject(this.bucketName, path);
    } catch (error) {
      this.logger.error(`Delete failed: ${error.message}`);
      throw new BadRequestException(`Delete failed: ${error.message}`);
    }
  }

  /**
   * List files for an employee
   */
  async listEmployeeFiles(
    employeeId: string,
    category?: string,
  ): Promise<any[]> {
    const prefix = category
      ? `documents/${employeeId}/${category}/`
      : `documents/${employeeId}/`;

    const minio = await this.client();

    return new Promise((resolve, reject) => {
      const data: any[] = [];
      const stream = minio.listObjectsV2(this.bucketName, prefix, true);

      stream.on('data', (obj) => {
        data.push({
          name: obj.name,
          size: obj.size,
          lastModified: obj.lastModified,
          url: this.getPublicUrl(obj.name || ''),
        });
      });

      stream.on('error', (err) => {
        this.logger.error(`List failed: ${err.message}`);
        reject(new BadRequestException(`List failed: ${err.message}`));
      });

      stream.on('end', () => {
        resolve(data);
      });
    });
  }

  /**
   * Validate image file
   */
  private validateImageFile(file: Express.Multer.File): void {
    const allowedMimes = [
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/webp',
      'image/svg+xml',
    ];
    const maxSize = 5 * 1024 * 1024; // 5MB

    if (!allowedMimes.includes(file.mimetype)) {
      throw new BadRequestException(
        'Only JPEG, PNG, SVG and WebP images are allowed',
      );
    }

    if (file.size > maxSize) {
      throw new BadRequestException('File size must not exceed 5MB');
    }
  }

  /**
   * Validate PDF file
   */
  private validatePdfFile(file: Express.Multer.File): void {
    const maxSize = 10 * 1024 * 1024; // 10MB

    if (file.mimetype !== 'application/pdf') {
      throw new BadRequestException('Only PDF files are allowed');
    }

    if (file.size > maxSize) {
      throw new BadRequestException('File size must not exceed 10MB');
    }
  }

  /**
   * Validate document file
   */
  private validateDocumentFile(file: Express.Multer.File): void {
    const allowedMimes = [
      'application/pdf',
      'image/jpeg',
      'image/jpg',
      'image/png',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];
    const maxSize = 10 * 1024 * 1024; // 10MB

    if (!allowedMimes.includes(file.mimetype)) {
      throw new BadRequestException('File type not allowed');
    }

    if (file.size > maxSize) {
      throw new BadRequestException('File size must not exceed 10MB');
    }
  }
}

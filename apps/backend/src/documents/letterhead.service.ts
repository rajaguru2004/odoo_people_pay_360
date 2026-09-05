import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { StorageService } from '../storage/storage.service';
import { assertInBranch, getEffectiveBranchId } from '../common/branch/branch-scope.util';
import {
  DOCUMENT_ASSET_FOLDER,
  JPEG_MAGIC,
  LETTERHEAD_ALLOWED_MIMES,
  LETTERHEAD_ASPECT_TOLERANCE,
  LETTERHEAD_MAX_BYTES,
  LETTERHEAD_MIME_MESSAGE,
  LETTERHEAD_MIN_HEIGHT_PX,
  LETTERHEAD_MIN_WIDTH_PX,
  PNG_MAGIC,
} from './constants';

type Principal = { id?: string; userId?: string; role: string; isGlobalBranchAccess?: boolean };

export interface UploadedImage {
  buffer: Buffer;
  originalname?: string;
  mimetype?: string;
  size?: number;
}

/** Cache of inlined artwork, keyed by content hash — which never changes. */
const dataUriCache = new Map<string, string>();

@Injectable()
export class LetterheadService {
  private readonly logger = new Logger(LetterheadService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Read the real dimensions out of the file header.
   *
   * Parsed by hand rather than pulled through an image library: the two
   * formats accepted here put their dimensions in a fixed place, and this
   * doubles as a structural check — a file whose header cannot be walked is
   * not the image it claims to be, whatever its extension says.
   */
  private dimensions(buf: Buffer): { width: number; height: number } | null {
    if (buf.subarray(0, 8).equals(PNG_MAGIC)) {
      // IHDR is always the first chunk: length(4) type(4) width(4) height(4).
      if (buf.length < 24) return null;
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf.subarray(0, 3).equals(JPEG_MAGIC)) {
      let offset = 2;
      while (offset + 9 < buf.length) {
        if (buf[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = buf[offset + 1];
        // SOF0..SOF15, excluding the non-frame markers in that range.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
        }
        offset += 2 + buf.readUInt16BE(offset + 2);
      }
      return null;
    }
    return null;
  }

  /**
   * Validate an uploaded letterhead.
   *
   * The mimetype the browser sends is a claim; the magic bytes are evidence.
   * `upload.service.ts` matches on the claim alone, which is a known gap in
   * this codebase — this path does not inherit it, because the file it accepts
   * is about to be inlined into a rendered document.
   */
  private assertValidImage(file: UploadedImage): { width: number; height: number } {
    if (!file?.buffer?.length) {
      throw new BadRequestException('No file was uploaded.');
    }
    if (file.buffer.length > LETTERHEAD_MAX_BYTES) {
      throw new BadRequestException(
        `This file is ${(file.buffer.length / 1024 / 1024).toFixed(1)} MB. The limit is ` +
          `${LETTERHEAD_MAX_BYTES / 1024 / 1024} MB — try exporting it as a PNG at 150 DPI.`,
      );
    }

    const isPng = file.buffer.subarray(0, 8).equals(PNG_MAGIC);
    const isJpeg = file.buffer.subarray(0, 3).equals(JPEG_MAGIC);
    if (!isPng && !isJpeg) {
      throw new BadRequestException(LETTERHEAD_MIME_MESSAGE);
    }

    const dim = this.dimensions(file.buffer);
    if (!dim || !dim.width || !dim.height) {
      throw new BadRequestException(
        'That image could not be read. Re-export it as a PNG or JPEG and try again.',
      );
    }
    // Compared against the SHORT and LONG edges rather than width and height,
    // so a landscape letter pad is judged on its resolution rather than
    // refused for not being portrait. Locking the check to portrait would
    // reject a perfectly good 1754×1240 image for being "too small".
    const shortEdge = Math.min(dim.width, dim.height);
    const longEdge = Math.max(dim.width, dim.height);
    if (shortEdge < LETTERHEAD_MIN_WIDTH_PX || longEdge < LETTERHEAD_MIN_HEIGHT_PX) {
      // The measured numbers, not a generic refusal: the person can act on
      // "640×480" and cannot act on "image too small".
      throw new BadRequestException(
        `That image is ${dim.width}×${dim.height}. A letterhead should be at least ` +
          `${LETTERHEAD_MIN_WIDTH_PX}×${LETTERHEAD_MIN_HEIGHT_PX} (A4 at 150 DPI) or it will look ` +
          'blurry when printed.',
      );
    }
    return dim;
  }

  /** A4 portrait aspect, within tolerance. A warning, not a refusal. */
  private aspectWarning(width: number, height: number): string | null {
    // Compared on the long/short ratio so a landscape page is measured against
    // A4 landscape rather than being told it is the wrong shape.
    const a4 = 297 / 210;
    const actual = Math.max(width, height) / Math.min(width, height);
    if (Math.abs(actual - a4) / a4 <= LETTERHEAD_ASPECT_TOLERANCE) return null;
    return (
      `This image is ${width}×${height}, which is not A4 proportions. Your content may not line ` +
      'up with the artwork.'
    );
  }

  async upload(
    file: UploadedImage,
    dto: {
      name?: string;
      scope?: 'COMPANY' | 'BRANCH';
      branchId?: string;
      kind?: 'LETTERHEAD' | 'SIGNATURE' | 'SEAL';
      safeTopMm?: number;
      safeRightMm?: number;
      safeBottomMm?: number;
      safeLeftMm?: number;
    },
    user: Principal,
  ) {
    const dim = this.assertValidImage(file);
    const scope = dto.scope ?? 'COMPANY';
    const branchId = scope === 'BRANCH' ? dto.branchId ?? getEffectiveBranchId() : null;

    if (scope === 'BRANCH') {
      if (!branchId) {
        throw new BadRequestException('Select a branch before uploading a branch letterhead.');
      }
      await assertInBranch(branchId);
    } else if (!user.isGlobalBranchAccess) {
      // A company-wide letterhead is every branch's stationery.
      throw new BadRequestException(
        'Only an administrator with access to all branches can set the company-wide letterhead.',
      );
    }

    const contentHash = createHash('sha256').update(file.buffer).digest('hex');
    const ext = file.buffer.subarray(0, 8).equals(PNG_MAGIC) ? 'png' : 'jpg';
    const fileName = `${contentHash.slice(0, 16)}.${ext}`;

    // PRIVATE bucket. The public one carries an allow-all read policy, and
    // world-readable stationery is a forgery kit — it is the artwork that
    // makes a document look authentic to a bank.
    const privateRef = await this.storage.uploadPrivateFile(
      file.buffer,
      fileName,
      DOCUMENT_ASSET_FOLDER,
    );

    const asset = await this.prisma.documentAsset.create({
      data: {
        kind: dto.kind ?? 'LETTERHEAD',
        name: dto.name ?? file.originalname ?? 'Letterhead',
        scope,
        branchId,
        privateRef,
        mimeType: ext === 'png' ? 'image/png' : 'image/jpeg',
        fileSize: BigInt(file.buffer.length),
        contentHash,
        widthPx: dim.width,
        heightPx: dim.height,
        ...(dto.safeTopMm !== undefined ? { safeTopMm: dto.safeTopMm } : {}),
        ...(dto.safeRightMm !== undefined ? { safeRightMm: dto.safeRightMm } : {}),
        ...(dto.safeBottomMm !== undefined ? { safeBottomMm: dto.safeBottomMm } : {}),
        ...(dto.safeLeftMm !== undefined ? { safeLeftMm: dto.safeLeftMm } : {}),
        createdById: user.id ?? user.userId ?? null,
      },
    });

    await this.audit.log({
      userId: user.id ?? user.userId,
      action: 'DOCUMENT_ASSET_UPLOADED',
      resourceType: 'DocumentAsset',
      resourceId: asset.id,
      newData: { kind: asset.kind, scope, branchId, contentHash },
      branchId,
    });

    return { ...this.toSummary(asset), warning: this.aspectWarning(dim.width, dim.height) };
  }

  async list(kind?: string) {
    const rows = await this.prisma.documentAsset.findMany({
      where: { isActive: true, ...(kind ? { kind } : {}) },
      include: { branch: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((a) => this.toSummary(a));
  }

  async updateSafeArea(
    id: string,
    dto: { safeTopMm?: number; safeRightMm?: number; safeBottomMm?: number; safeLeftMm?: number; name?: string },
    user: Principal,
  ) {
    const asset = await this.prisma.documentAsset.findUnique({ where: { id } });
    if (!asset) throw new NotFoundException('Letterhead not found');
    await assertInBranch(asset.branchId);

    const updated = await this.prisma.documentAsset.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.safeTopMm !== undefined ? { safeTopMm: dto.safeTopMm } : {}),
        ...(dto.safeRightMm !== undefined ? { safeRightMm: dto.safeRightMm } : {}),
        ...(dto.safeBottomMm !== undefined ? { safeBottomMm: dto.safeBottomMm } : {}),
        ...(dto.safeLeftMm !== undefined ? { safeLeftMm: dto.safeLeftMm } : {}),
      },
    });
    await this.audit.log({
      userId: user.id ?? user.userId,
      action: 'DOCUMENT_ASSET_UPDATED',
      resourceType: 'DocumentAsset',
      resourceId: id,
      newData: dto,
    });
    return this.toSummary(updated);
  }

  async remove(id: string, user: Principal) {
    const asset = await this.prisma.documentAsset.findUnique({
      where: { id },
      include: { _count: { select: { versions: true } } },
    });
    if (!asset) throw new NotFoundException('Letterhead not found');
    await assertInBranch(asset.branchId);

    if (asset._count.versions > 0) {
      // Deactivated, never deleted: a published version PINS its letterhead,
      // and a document issued last year must still show last year's
      // stationery. The FK is ON DELETE RESTRICT for the same reason.
      await this.prisma.documentAsset.update({ where: { id }, data: { isActive: false } });
      await this.audit.log({
        userId: user.id ?? user.userId,
        action: 'DOCUMENT_ASSET_RETIRED',
        resourceType: 'DocumentAsset',
        resourceId: id,
      });
      return {
        success: true,
        message:
          `This letterhead is still used by ${asset._count.versions} published template version(s), ` +
          'so it has been retired rather than deleted — documents already issued keep their artwork.',
      };
    }

    await this.prisma.documentAsset.delete({ where: { id } });
    await this.storage.deletePrivateFile(asset.privateRef).catch(() => undefined);
    await this.audit.log({
      userId: user.id ?? user.userId,
      action: 'DOCUMENT_ASSET_DELETED',
      resourceType: 'DocumentAsset',
      resourceId: id,
    });
    return { success: true, message: 'Letterhead deleted.' };
  }

  /**
   * Artwork as a `data:` URI, for the renderer.
   *
   * Cached on the CONTENT HASH, which is immutable — uploading new artwork
   * creates a new row rather than mutating one, so this cache can never go
   * stale and never needs invalidating.
   */
  async dataUriFor(assetId: string): Promise<{
    firstPageDataUri: string | null;
    continuationDataUri: string | null;
    safeTopMm: number;
    safeRightMm: number;
    safeBottomMm: number;
    safeLeftMm: number;
  } | null> {
    const asset = await this.prisma.documentAsset.findUnique({ where: { id: assetId } });
    if (!asset) return null;

    const inline = async (ref: string | null, hash: string | null): Promise<string | null> => {
      if (!ref || !hash) return null;
      const hit = dataUriCache.get(hash);
      if (hit) return hit;
      try {
        const { buffer } = await this.storage.readPrivateFile(ref);
        const uri = `data:${asset.mimeType};base64,${buffer.toString('base64')}`;
        dataUriCache.set(hash, uri);
        return uri;
      } catch (err) {
        // A missing letterhead must degrade to a document without artwork,
        // never to a document that could not be issued.
        this.logger.warn(
          `Letterhead ${assetId} could not be read: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    };

    return {
      firstPageDataUri: await inline(asset.privateRef, asset.contentHash),
      continuationDataUri: await inline(asset.contPrivateRef, asset.contContentHash),
      safeTopMm: Number(asset.safeTopMm),
      safeRightMm: Number(asset.safeRightMm),
      safeBottomMm: Number(asset.safeBottomMm),
      safeLeftMm: Number(asset.safeLeftMm),
    };
  }

  private toSummary(a: {
    id: string;
    kind: string;
    name: string;
    scope: string;
    branchId: string | null;
    mimeType: string;
    fileSize: bigint;
    widthPx: number | null;
    heightPx: number | null;
    safeTopMm: unknown;
    safeRightMm: unknown;
    safeBottomMm: unknown;
    safeLeftMm: unknown;
    isActive: boolean;
    createdAt: Date;
    branch?: { id: string; name: string } | null;
  }) {
    return {
      id: a.id,
      kind: a.kind,
      name: a.name,
      scope: a.scope,
      branchId: a.branchId,
      branchName: a.branch?.name ?? null,
      mimeType: a.mimeType,
      // Number, not BigInt: BigInt does not survive JSON.stringify.
      fileSize: Number(a.fileSize),
      widthPx: a.widthPx,
      heightPx: a.heightPx,
      safeTopMm: Number(a.safeTopMm),
      safeRightMm: Number(a.safeRightMm),
      safeBottomMm: Number(a.safeBottomMm),
      safeLeftMm: Number(a.safeLeftMm),
      isActive: a.isActive,
      createdAt: a.createdAt,
      previewPath: `/secure-files/document-asset/${a.id}`,
    };
  }

  /** Secure-download resolution for the preview image. */
  async fileFor(id: string) {
    const asset = await this.prisma.documentAsset.findUnique({ where: { id } });
    if (!asset) throw new NotFoundException('Letterhead not found');
    await assertInBranch(asset.branchId);
    return {
      privateRef: asset.privateRef,
      fileName: `${asset.name}.${asset.mimeType === 'image/png' ? 'png' : 'jpg'}`,
    };
  }
}

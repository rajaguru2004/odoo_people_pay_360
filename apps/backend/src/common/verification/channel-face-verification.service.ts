import { Injectable, Logger } from '@nestjs/common';
import { FaceRecognitionService } from '../../face-recognition/face-recognition.service';
import {
  ChannelVerificationTokenService,
  VerificationRow,
} from './channel-verification-token.service';

/**
 * Matches a face against the employee a verification row belongs to, and files
 * the receipt.
 *
 * Kept apart from the token service so that FaceRecognitionModule — which lazily
 * loads a TensorFlow model — stays out of McpModule's graph. The tool layer
 * needs `spendFaceProof`; it does not need a face detector.
 *
 * ## What a face proof does and does not prove
 *
 * A saved photo and a live capture are INDISTINGUISHABLE at this layer.
 * Uploads arrive stripped of EXIF and re-encoded, so nothing in the bytes is a
 * provenance claim. Even the browser path's getUserMedia frame is defeatable
 * by a virtual camera.
 *
 * So this proves possession of the enrolled account plus possession of a photo
 * that matches the employee. It does not prove presence. What it adds on top,
 * in descending order of value:
 *
 *   1. Exact-bytes replay detection — re-sending the same photo is both the
 *      most likely abuse and the cheapest to catch.
 *   2. A bounded challenge window and an attempt cap, upstream of here.
 *   3. An audit trail with an admin-visible image. In an HR context, being
 *      reviewable after the fact deters more than anything checkable in the
 *      moment.
 */
@Injectable()
export class ChannelFaceVerificationService {
  private readonly logger = new Logger(ChannelFaceVerificationService.name);

  constructor(
    private readonly faces: FaceRecognitionService,
    private readonly tokens: ChannelVerificationTokenService,
  ) {}

  async verifyAndRecord(
    row: VerificationRow,
    image: string,
    fingerprint: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    if (!row.employeeId) {
      return { ok: false, message: 'This account is not linked to an employee record.' };
    }

    // Cheapest check first, and the one that catches the likeliest abuse.
    if (await this.tokens.imageAlreadyUsed(row.employeeId, fingerprint)) {
      return {
        ok: false,
        message: 'That is a photo you have already used. Please take a new one.',
      };
    }

    const result = await this.faces.verifyEmployeeFace(image, row.employeeId);
    if (!result.ok) return { ok: false, message: result.message };

    // Best-effort: the punch should not fail because storage is down, but the
    // receipt records whether an image was actually kept.
    const imageUrl = await this.faces
      .storeAttendanceCapture(image, row.employeeId, row.purpose.toLowerCase())
      .catch(() => null);

    await this.tokens.recordFaceProof(row.id, {
      distance: result.distance,
      quality: result.quality,
      imageUrl,
      imageSha256: fingerprint,
    });

    this.logger.log(
      `Face verified for employee ${row.employeeId} (${row.channel}/${row.purpose}) ` +
        `distance=${result.distance.toFixed(3)} quality=${result.quality.toFixed(2)}`,
    );
    return { ok: true };
  }
}

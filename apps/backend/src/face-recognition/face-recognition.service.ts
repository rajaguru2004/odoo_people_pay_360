import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { AttendancesService } from '../attendances/attendances.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
// Use WASM variant - no native compilation needed (works on all platforms)

const faceapi = require('@vladmandic/face-api/dist/face-api.node-wasm.js');
import {
  createCanvas,
  loadImage,
  GlobalFonts,
  Image as NImage,
} from '@napi-rs/canvas';
import * as path from 'path';

// Monkey-patch face-api.js to use @napi-rs/canvas
// @napi-rs/canvas has a compatible API
faceapi.env.monkeyPatch({
  Canvas: (createCanvas as any).constructor || Object,
  Image: NImage || Object,
});

@Injectable()
export class FaceRecognitionService implements OnModuleInit {
  private readonly logger = new Logger(FaceRecognitionService.name);
  private modelsLoaded = false;
  private tf: any = null;
  private readonly threshold: number;
  private readonly maxDescriptorsPerEmployee: number;
  private readonly minQuality: number;

  constructor(
    private prisma: PrismaService,
    private storageService: StorageService,
    private attendancesService: AttendancesService,
    private configService: ConfigService,
    private systemSettingsService: SystemSettingsService,
  ) {
    this.threshold = parseFloat(
      this.configService.get<string>('FACE_RECOGNITION_THRESHOLD', '0.6'),
    );
    this.maxDescriptorsPerEmployee = parseInt(
      this.configService.get<string>('FACE_RECOGNITION_MAX_DESCRIPTORS', '5'),
      10,
    );
    this.minQuality = parseFloat(
      this.configService.get<string>('FACE_RECOGNITION_MIN_QUALITY', '0.5'),
    );
  }

  async onModuleInit() {
    // Only load heavy AI models if face recognition is enabled in system settings
    try {
      const enabled = await this.systemSettingsService.getSetting(
        'face_recognition_enabled',
        'true',
      );
      if (enabled !== 'false') {
        await this.loadModels();
      } else {
        this.logger.log(
          'Face recognition disabled in system settings — skipping model load',
        );
      }
    } catch {
      // If settings DB not ready yet, default to loading models
      await this.loadModels();
    }
  }

  /**
   * Load face-api.js pre-trained models (SSD MobileNetV1 + landmarks + recognition)
   */
  private async loadModels(): Promise<void> {
    if (this.modelsLoaded) return;

    try {
      // Initialize TF.js WASM backend before loading models
      this.tf = require('@tensorflow/tfjs');
      require('@tensorflow/tfjs-backend-wasm');
      await this.tf.setBackend('wasm');
      await this.tf.ready();
      this.logger.log(`TensorFlow.js backend: ${this.tf.getBackend()}`);

      // Resolved from the package itself, never from `process.cwd()` +
      // node_modules: npm workspaces hoists dependencies to the MONOREPO root,
      // so apps/backend/node_modules/@vladmandic does not exist and a cwd-based
      // join sends loadFromDisk at a path that is never there.
      const modelsPath = path.join(
        path.dirname(require.resolve('@vladmandic/face-api/package.json')),
        'model',
      );

      this.logger.log(`Loading face-api models from: ${modelsPath}`);

      await faceapi.nets.ssdMobilenetv1.loadFromDisk(modelsPath);
      await faceapi.nets.faceLandmark68Net.loadFromDisk(modelsPath);
      await faceapi.nets.faceRecognitionNet.loadFromDisk(modelsPath);

      this.modelsLoaded = true;
      this.logger.log('Face-API models loaded successfully');
    } catch (error) {
      this.logger.error('Failed to load face-api models:', error);
      throw error;
    }
  }

  /**
   * Extract face descriptor (128-dim vector) from a base64 image
   */
  private async extractDescriptor(
    base64Image: string,
  ): Promise<{ descriptor: Float32Array; quality: number }> {
    if (!this.modelsLoaded) {
      await this.loadModels();
    }

    // Strip data URI prefix if present
    const base64Data = base64Image.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    // Load image using @napi-rs/canvas
    const img = await loadImage(buffer);
    const cvs = createCanvas(img.width, img.height);
    const ctx = cvs.getContext('2d');
    ctx.drawImage(img, 0, 0);

    // face-api WASM build does not accept @napi-rs/canvas Canvas directly.
    // Convert pixel data to tf.Tensor3D (shape [H, W, 3] int32) which face-api accepts.
    const imageData = ctx.getImageData(0, 0, img.width, img.height);
    const { width, height } = img;
    const rgbData = new Uint8Array(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      rgbData[i * 3] = imageData.data[i * 4]; // R
      rgbData[i * 3 + 1] = imageData.data[i * 4 + 1]; // G
      rgbData[i * 3 + 2] = imageData.data[i * 4 + 2]; // B
    }
    const tensor = this.tf.tensor3d(rgbData, [height, width, 3], 'int32');

    // Detect face with landmarks and compute descriptor
    let detection: any;
    try {
      detection = await faceapi
        .detectSingleFace(tensor)
        .withFaceLandmarks()
        .withFaceDescriptor();
    } finally {
      tensor.dispose();
    }

    if (!detection) {
      throw new BadRequestException(
        'No face detected in the image. Please retake with good lighting and look directly at the camera.',
      );
    }
    const quality = detection.detection.score;

    if (quality < this.minQuality) {
      throw new BadRequestException(
        `Image quality too low (${(quality * 100).toFixed(1)}%). Minimum ${(this.minQuality * 100).toFixed(0)}% required. Please retake.`,
      );
    }

    return {
      descriptor: detection.descriptor,
      quality,
    };
  }

  /**
   * Calculate Euclidean distance between two descriptors
   */
  private euclideanDistance(a: Float32Array | number[], b: number[]): number {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
      const diff = a[i] - b[i];
      sum += diff * diff;
    }
    return Math.sqrt(sum);
  }

  // ==================== PUBLIC API ====================

  /**
   * Register a face descriptor for an employee
   */
  async registerFace(
    image: string,
    currentUser: { employeeId: string; role: string },
    targetEmployeeId?: string,
  ) {
    // Determine which employee to register for
    const employeeId = targetEmployeeId || currentUser.employeeId;

    // Only admin/HR can register for other employees
    if (
      targetEmployeeId &&
      targetEmployeeId !== currentUser.employeeId &&
      !['ADMIN', 'HR_MANAGER'].includes(currentUser.role)
    ) {
      throw new BadRequestException(
        'You do not have permission to register a face for another employee.',
      );
    }

    // Check employee exists
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, fullName: true, employeeCode: true },
    });

    if (!employee) {
      throw new NotFoundException('Employee not found.');
    }

    // Check max descriptors limit
    const existingCount = await this.prisma.faceDescriptor.count({
      where: { employeeId },
    });

    if (existingCount >= this.maxDescriptorsPerEmployee) {
      throw new BadRequestException(
        `Maximum limit of ${this.maxDescriptorsPerEmployee} images reached. Please delete old images before registering more.`,
      );
    }

    // Extract face descriptor
    const { descriptor, quality } = await this.extractDescriptor(image);

    // Check for duplicate (too similar to existing descriptor)
    const existingDescriptors = await this.prisma.faceDescriptor.findMany({
      where: { employeeId },
      select: { descriptor: true },
    });

    for (const existing of existingDescriptors) {
      const distance = this.euclideanDistance(descriptor, existing.descriptor);
      if (distance < 0.3) {
        throw new BadRequestException(
          'Image is too similar to registered images. Please take a photo from a different angle.',
        );
      }
    }

    // Save to storage (optional, for display)
    let imageUrl: string | null = null;
    try {
      const fileBuffer = Buffer.from(
        image.replace(/^data:image\/\w+;base64,/, ''),
        'base64',
      );
      const folder = `face-descriptors/${employeeId}`;
      const fileName = `${Date.now()}.jpg`;
      imageUrl = await this.storageService.uploadFile(
        fileBuffer,
        fileName,
        folder,
      );
    } catch (err) {
      this.logger.warn('Failed to upload face image to storage:', err);
    }

    // Save descriptor to DB
    const saved = await this.prisma.faceDescriptor.create({
      data: {
        employeeId,
        descriptor: Array.from(descriptor),
        quality,
        imageUrl,
      },
    });

    return {
      success: true,
      message: `Face registered successfully (${existingCount + 1}/${this.maxDescriptorsPerEmployee})`,
      data: {
        id: saved.id,
        quality,
        imageUrl,
        totalRegistered: existingCount + 1,
        maxAllowed: this.maxDescriptorsPerEmployee,
        employee: {
          id: employee.id,
          fullName: employee.fullName,
          employeeCode: employee.employeeCode,
        },
      },
    };
  }

  /**
   * Face check-in: match face against all registered descriptors
   */
  async faceCheckIn(
    image: string,
    currentEmployeeId?: string,
    coords?: { latitude?: number; longitude?: number; accuracy?: number },
  ) {
    const { descriptor, quality } = await this.extractDescriptor(image);
    const match = await this.findBestMatch(descriptor, currentEmployeeId);

    if (!match) {
      // Log for debugging
      this.logger.warn(
        `Face check-in failed: No match found. Quality: ${quality.toFixed(2)}, Threshold: ${this.threshold}`,
      );
      throw new BadRequestException(
        `No matching face found (confidence < ${Math.round((1 - this.threshold) * 100)}%). ` +
          `Please ensure you have registered your face and look directly at the camera.`,
      );
    }

    // Call the attendances service to do the actual check-in
    const attendance = await this.attendancesService.checkIn(
      match.employeeId,
      true,
      coords,
    );

    return {
      success: true,
      message: `Check-in successful - ${match.employee.fullName}`,
      data: {
        employee: match.employee,
        attendance: attendance.data,
        recognition: {
          confidence: Math.round((1 - match.distance) * 100),
          distance: match.distance,
          quality: Math.round(quality * 100),
          threshold: this.threshold,
        },
      },
    };
  }

  /**
   * Face check-out: match face against all registered descriptors
   */
  async faceCheckOut(image: string, currentEmployeeId?: string) {
    const { descriptor, quality } = await this.extractDescriptor(image);
    const match = await this.findBestMatch(descriptor, currentEmployeeId);

    if (!match) {
      throw new BadRequestException(
        'Face not recognized. Please look directly at the camera and try again.',
      );
    }

    const attendance = await this.attendancesService.checkOut(
      match.employeeId,
      true,
    );

    return {
      success: true,
      message: `Check-out successful - ${match.employee.fullName}`,
      data: {
        employee: match.employee,
        attendance: attendance.data,
        recognition: {
          confidence: Math.round((1 - match.distance) * 100),
          distance: match.distance,
          quality: Math.round(quality * 100),
          threshold: this.threshold,
        },
      },
    };
  }

  async faceLunchCheckIn(image: string, currentEmployeeId?: string) {
    const { descriptor, quality } = await this.extractDescriptor(image);
    const match = await this.findBestMatch(descriptor, currentEmployeeId);

    if (!match) {
      throw new BadRequestException(
        'Face not recognized. Please look directly at the camera and try again.',
      );
    }

    const attendance = await this.attendancesService.lunchCheckIn(
      match.employeeId,
      true,
    );

    return {
      success: true,
      message: `Lunch check-in successful - ${match.employee.fullName}`,
      data: {
        employee: match.employee,
        attendance: attendance.data,
        recognition: {
          confidence: Math.round((1 - match.distance) * 100),
          distance: match.distance,
          quality: Math.round(quality * 100),
          threshold: this.threshold,
        },
      },
    };
  }

  async faceLunchCheckOut(image: string, currentEmployeeId?: string) {
    const { descriptor, quality } = await this.extractDescriptor(image);
    const match = await this.findBestMatch(descriptor, currentEmployeeId);

    if (!match) {
      throw new BadRequestException(
        'Face not recognized. Please look directly at the camera and try again.',
      );
    }

    const attendance = await this.attendancesService.lunchCheckOut(
      match.employeeId,
      true,
    );

    return {
      success: true,
      message: `Lunch check-out successful - ${match.employee.fullName}`,
      data: {
        employee: match.employee,
        attendance: attendance.data,
        recognition: {
          confidence: Math.round((1 - match.distance) * 100),
          distance: match.distance,
          quality: Math.round(quality * 100),
          threshold: this.threshold,
        },
      },
    };
  }

  /**
   * Find the best matching employee for a given face descriptor
   */
  private async findBestMatch(
    descriptor: Float32Array,
    employeeId?: string,
  ): Promise<{
    employeeId: string;
    employee: {
      id: string;
      fullName: string;
      employeeCode: string;
      avatarUrl: string | null;
    };
    distance: number;
  } | null> {
    const allDescriptors = await this.prisma.faceDescriptor.findMany({
      where: employeeId ? { employeeId } : undefined,
      select: {
        descriptor: true,
        employeeId: true,
        employee: {
          select: {
            id: true,
            fullName: true,
            employeeCode: true,
            avatarUrl: true,
          },
        },
      },
    });

    if (allDescriptors.length === 0) {
      return null;
    }

    let bestMatch: {
      employeeId: string;
      employee: {
        id: string;
        fullName: string;
        employeeCode: string;
        avatarUrl: string | null;
      };
      distance: number;
    } | null = null;

    let closestDistance = Infinity;

    for (const stored of allDescriptors) {
      const distance = this.euclideanDistance(descriptor, stored.descriptor);

      // Track closest match for logging
      if (distance < closestDistance) {
        closestDistance = distance;
      }

      if (distance < this.threshold) {
        if (!bestMatch || distance < bestMatch.distance) {
          bestMatch = {
            employeeId: stored.employeeId,
            employee: stored.employee,
            distance,
          };
        }
      }
    }

    // Log for debugging
    if (!bestMatch && closestDistance !== Infinity) {
      this.logger.warn(
        `No match found. Closest distance: ${closestDistance.toFixed(3)} (threshold: ${this.threshold}, ` +
          `confidence would be: ${Math.round((1 - closestDistance) * 100)}%)`,
      );
    }

    return bestMatch;
  }

  /**
   * Get registration status for current user
   */
  async getRegistrationStatus(employeeId: string) {
    const count = await this.prisma.faceDescriptor.count({
      where: { employeeId },
    });

    return {
      success: true,
      data: {
        isRegistered: count > 0,
        totalRegistered: count,
        maxAllowed: this.maxDescriptorsPerEmployee,
        canRegisterMore: count < this.maxDescriptorsPerEmployee,
      },
    };
  }

  /**
   * Get all descriptors for an employee
   */
  async getEmployeeDescriptors(employeeId: string) {
    const descriptors = await this.prisma.faceDescriptor.findMany({
      where: { employeeId },
      select: {
        id: true,
        imageUrl: true,
        quality: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      success: true,
      data: descriptors,
    };
  }

  /**
   * Delete a face descriptor (own)
   */
  async deleteDescriptor(id: string, employeeId: string) {
    const descriptor = await this.prisma.faceDescriptor.findFirst({
      where: { id, employeeId },
    });

    if (!descriptor) {
      throw new NotFoundException('Face template not found.');
    }

    // Delete image from storage if exists
    if (descriptor.imageUrl) {
      try {
        await this.storageService.deleteFile(descriptor.imageUrl);
      } catch (err) {
        this.logger.warn('Failed to delete face image from storage:', err);
      }
    }

    await this.prisma.faceDescriptor.delete({ where: { id } });

    return {
      success: true,
      message: 'Face template deleted.',
    };
  }

  /**
   * Delete a face descriptor (admin - any employee)
   */
  async deleteDescriptorAdmin(id: string) {
    const descriptor = await this.prisma.faceDescriptor.findUnique({
      where: { id },
    });

    if (!descriptor) {
      throw new NotFoundException('Face template not found.');
    }

    if (descriptor.imageUrl) {
      try {
        await this.storageService.deleteFile(descriptor.imageUrl);
      } catch (err) {
        this.logger.warn('Failed to delete face image from storage:', err);
      }
    }

    await this.prisma.faceDescriptor.delete({ where: { id } });

    return {
      success: true,
      message: 'Face template deleted.',
    };
  }

  /**
   * Test face recognition (admin debug endpoint)
   */
  async testRecognition(image: string) {
    const { descriptor, quality } = await this.extractDescriptor(image);
    const match = await this.findBestMatch(descriptor);

    return {
      success: true,
      data: {
        faceDetected: true,
        quality,
        match: match
          ? {
              employee: match.employee,
              confidence: Math.round((1 - match.distance) * 100),
              distance: match.distance,
              threshold: this.threshold,
              isMatch: match.distance < this.threshold,
            }
          : null,
      },
    };
  }

  // ==================== CAPTURE-ONLY API (no AI) ====================

  /**
   * Upload face image to S3 and record check-in WITHOUT running AI recognition.
   * Used when face_recognition_enabled = false.
   */
  /**
   * The capture-* endpoints record attendance from a stored photo WITHOUT
   * running recognition. That is the correct fallback when the matcher is
   * turned OFF — but it must never be a way around the matcher when it is ON.
   *
   * `attendance_face_only` is the switch a site turns on when it wants
   * attendance to be provable: no verified face, no punch. These four doors
   * used to satisfy it trivially, because they call `checkIn(..., byFace=true)`
   * and `uploadAttendanceImage` swallows every error — so the payload did not
   * even have to be an image. Any authenticated employee could post an
   * arbitrary string and be punched in, with the row marked face-verified.
   */
  private async assertCaptureAllowed(): Promise<void> {
    const faceOnly =
      (await this.systemSettingsService.getSetting(
        'attendance_face_only',
        'false',
      )) === 'true';
    const recognitionEnabled =
      (await this.systemSettingsService.getSetting(
        'face_recognition_enabled',
        'true',
      )) !== 'false';

    // Capture-only is the fallback for a disabled matcher, never a bypass of an
    // enabled one. With both switches on, the caller must go through the
    // matching endpoints.
    if (faceOnly && recognitionEnabled) {
      throw new BadRequestException(
        'Attendance can only be registered using face verification.',
      );
    }
  }

  async captureCheckIn(
    image: string,
    employeeId: string,
    coords?: { latitude?: number; longitude?: number; accuracy?: number },
  ) {
    await this.assertCaptureAllowed();
    await this.uploadAttendanceImage(image, employeeId, 'check-in');
    const attendance = await this.attendancesService.checkIn(
      employeeId,
      true,
      coords,
    );
    return {
      success: true,
      message: 'Check-in recorded — face image saved',
      data: { attendance: attendance.data },
    };
  }

  /**
   * Upload face image to S3 and record check-out WITHOUT running AI recognition.
   */
  async captureCheckOut(image: string, employeeId: string) {
    await this.assertCaptureAllowed();
    await this.uploadAttendanceImage(image, employeeId, 'check-out');
    const attendance = await this.attendancesService.checkOut(employeeId, true);
    return {
      success: true,
      message: 'Check-out recorded — face image saved',
      data: { attendance: attendance.data },
    };
  }

  /**
   * Upload face image to S3 and record lunch check-in WITHOUT running AI recognition.
   */
  async captureLunchCheckIn(image: string, employeeId: string) {
    await this.assertCaptureAllowed();
    await this.uploadAttendanceImage(image, employeeId, 'lunch-check-in');
    const attendance = await this.attendancesService.lunchCheckIn(
      employeeId,
      true,
    );
    return {
      success: true,
      message: 'Lunch check-in recorded — face image saved',
      data: { attendance: attendance.data },
    };
  }

  /**
   * Upload face image to S3 and record lunch check-out WITHOUT running AI recognition.
   */
  async captureLunchCheckOut(image: string, employeeId: string) {
    await this.assertCaptureAllowed();
    await this.uploadAttendanceImage(image, employeeId, 'lunch-check-out');
    const attendance = await this.attendancesService.lunchCheckOut(
      employeeId,
      true,
    );
    return {
      success: true,
      message: 'Lunch check-out recorded — face image saved',
      data: { attendance: attendance.data },
    };
  }

  // ------------------------------------------------- channel verification API

  /**
   * Does this image match THIS employee?
   *
   * Scoped to one employee id, resolved server-side from a principal or a
   * verification-token row — this never searches the roster, so a photo of a
   * colleague cannot punch anybody in.
   *
   * Returns a result rather than throwing. Every failure here becomes a chat
   * reply or a line on a phone screen, and BadRequestException text is the
   * wrong shape for either; `not_enrolled` in particular has to be told apart
   * from `no_match`, because "look directly at the camera" is unactionable
   * advice for somebody who never registered a face.
   */
  async verifyEmployeeFace(
    image: string,
    employeeId: string,
  ): Promise<
    | { ok: true; distance: number; quality: number }
    | {
        ok: false;
        reason: 'disabled' | 'not_enrolled' | 'no_face' | 'low_quality' | 'no_match';
        message: string;
      }
  > {
    // When recognition is off there is deliberately NO fallback to the
    // capture-only path. Those variants record `byFace: true` after uploading
    // an image with no matching at all — acceptable at a supervised kiosk,
    // catastrophic from a chat where anyone can send any photo. An admin who
    // genuinely wants capture-without-matching should choose IDENTITY_ONLY,
    // which at least describes what it is.
    const enabled =
      (await this.systemSettingsService.getSetting('face_recognition_enabled', 'true')) !== 'false';
    if (!enabled) {
      return {
        ok: false,
        reason: 'disabled',
        message: 'Face verification is switched off. Please use the HR app.',
      };
    }

    const enrolled = await this.prisma.faceDescriptor.count({ where: { employeeId } });
    if (enrolled === 0) {
      return {
        ok: false,
        reason: 'not_enrolled',
        message:
          'You have not registered your face yet. Open the HR portal → Face Recognition to set it up.',
      };
    }

    let descriptor: Float32Array;
    let quality: number;
    try {
      ({ descriptor, quality } = await this.extractDescriptor(image));
    } catch (e) {
      const message = (e as Error)?.message ?? '';
      const lowQuality = /quality too low/i.test(message);
      return {
        ok: false,
        reason: lowQuality ? 'low_quality' : 'no_face',
        message: lowQuality
          ? 'That photo was too blurry or too dark. Please retake it in better light.'
          : 'I could not find a face in that photo. Look straight at the camera and try again.',
      };
    }

    const match = await this.findBestMatch(descriptor, employeeId);
    if (!match) {
      return {
        ok: false,
        reason: 'no_match',
        message: 'That does not look like your registered photo. Please try again.',
      };
    }

    return { ok: true, distance: match.distance, quality };
  }

  /** Public wrapper over the capture upload, for the verification paths. */
  async storeAttendanceCapture(
    image: string,
    employeeId: string,
    action: string,
  ): Promise<string | null> {
    return this.uploadAttendanceImage(image, employeeId, action);
  }

  /**
   * Upload a base64 face image to storage under attendance-captures/<employeeId>/<action>-<timestamp>.jpg
   */
  private async uploadAttendanceImage(
    image: string,
    employeeId: string,
    action: string,
  ): Promise<string | null> {
    try {
      const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      const folder = `attendance-captures/${employeeId}`;
      const fileName = `${action}-${Date.now()}.jpg`;
      const url = await this.storageService.uploadFile(buffer, fileName, folder);
      this.logger.log(
        `Face capture uploaded for ${employeeId} (${action}): ${url}`,
      );
      return url;
    } catch (err) {
      this.logger.warn('Failed to upload attendance capture image:', err);
      return null;
    }
  }
}

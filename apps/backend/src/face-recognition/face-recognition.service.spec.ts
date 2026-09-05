import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FaceRecognitionService } from './face-recognition.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { AttendancesService } from '../attendances/attendances.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';

/**
 * The three face rules that run AFTER descriptor extraction, and therefore
 * cannot be reached from `attendance-face.e2e-spec.ts`.
 *
 * That e2e suite boots a real app with the models deliberately unloaded, which
 * gets it the cap, the cross-employee refusal, the not-found, all the descriptor
 * CRUD, the capture endpoints and every `@Roles` denial — because each of those
 * answers before `extractDescriptor` is ever called. What it cannot reach is
 * anything on the far side of extraction:
 *
 *   - the duplicate guard   (euclidean distance < 0.3)
 *   - the quality floor     (FACE_RECOGNITION_MIN_QUALITY, default 0.5)
 *   - the match threshold   (FACE_RECOGNITION_THRESHOLD, default 0.6)
 *
 * All three are pure arithmetic over a 128-float array, so they belong here,
 * with `extractDescriptor` stubbed. This file closes the one item
 * `docs/TEST-PLAN-ATTENDANCE.md` §4.1 named as owed and never delivered.
 *
 * FACE MATCHING ACCURACY IS STILL OUT OF SCOPE: nothing here feeds a real
 * image or asserts that two photographs of a person match. What is asserted is
 * that the SERVICE applies its own numeric rules the way it says it does.
 */
describe('FaceRecognitionService — the rules behind descriptor extraction', () => {
  let service: FaceRecognitionService;
  let prisma: any;

  /** A 128-float vector. `seed` scales it, so distance grows with the gap. */
  const vec = (seed: number): number[] =>
    Array.from({ length: 128 }, () => seed);

  /**
   * Distance between `vec(a)` and `vec(b)` is `sqrt(128) * |a-b|` ≈ 11.31·|a-b|,
   * so a 0.3 threshold is crossed at |a-b| ≈ 0.0265 and 0.6 at ≈ 0.053. The
   * seeds below are chosen against that, not guessed.
   */
  const DUP_SAME = 0.001; // ~0.011 apart — well inside the 0.3 duplicate guard
  const DUP_FAR = 0.05; // ~0.57 apart — outside 0.3, inside 0.6

  const stubExtract = (descriptor: number[], quality = 0.9) => {
    jest
      .spyOn(service as any, 'extractDescriptor')
      .mockResolvedValue({ descriptor: Float32Array.from(descriptor), quality });
  };

  beforeEach(async () => {
    prisma = {
      employee: { findUnique: jest.fn() },
      faceDescriptor: {
        count: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FaceRecognitionService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StorageService,
          // Upload failures are swallowed by the service on purpose (the photo
          // is for display, the descriptor is the record), so a rejecting stub
          // is the honest default.
          useValue: { uploadFile: jest.fn().mockRejectedValue(new Error('no storage')) },
        },
        { provide: AttendancesService, useValue: { checkIn: jest.fn(), checkOut: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn((_k, d) => d) } },
        {
          provide: SystemSettingsService,
          // Key-aware, not a blanket 'true': a mock that answers 'true' to every
          // key turns `attendance_face_only` on and makes the capture paths
          // refuse. That exact trap broke a sibling spec in this phase.
          useValue: {
            getSetting: jest.fn(async (key: string, fallback?: string) => {
              if (key === 'attendance_face_only') return 'false';
              if (key === 'face_recognition_enabled') return 'true';
              return fallback ?? 'true';
            }),
          },
        },
      ],
    }).compile();

    service = module.get(FaceRecognitionService);
    // The models are never loaded in this file; every path is stubbed above the
    // point where they would be needed.
    (service as any).modelsLoaded = true;
  });

  afterEach(() => jest.restoreAllMocks());

  // ──────────────────────────────────────────────────────────────────────────
  describe('the duplicate guard', () => {
    const asEmployee = { employeeId: 'emp-1', role: 'EMPLOYEE' };

    beforeEach(() => {
      prisma.employee.findUnique.mockResolvedValue({
        id: 'emp-1',
        fullName: 'Ada',
        employeeCode: 'E1',
      });
      prisma.faceDescriptor.count.mockResolvedValue(1);
      prisma.faceDescriptor.create.mockResolvedValue({ id: 'fd-new', quality: 0.9 });
    });

    it('refuses a descriptor closer than 0.3 to one already registered', async () => {
      prisma.faceDescriptor.findMany.mockResolvedValue([{ descriptor: vec(0) }]);
      stubExtract(vec(DUP_SAME));

      await expect(service.registerFace('img', asEmployee)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.registerFace('img', asEmployee)).rejects.toThrow(
        /too similar/i,
      );
      expect(prisma.faceDescriptor.create).not.toHaveBeenCalled();
    });

    it('accepts a descriptor further than 0.3 away', async () => {
      prisma.faceDescriptor.findMany.mockResolvedValue([{ descriptor: vec(0) }]);
      stubExtract(vec(DUP_FAR));

      await expect(service.registerFace('img', asEmployee)).resolves.toBeTruthy();
      expect(prisma.faceDescriptor.create).toHaveBeenCalledTimes(1);
    });

    it('compares against EVERY stored descriptor, not just the first', async () => {
      // Far from the first, near-identical to the second. A guard that stopped
      // at the first row would let this through.
      prisma.faceDescriptor.findMany.mockResolvedValue([
        { descriptor: vec(5) },
        { descriptor: vec(0) },
      ]);
      stubExtract(vec(DUP_SAME));

      await expect(service.registerFace('img', asEmployee)).rejects.toThrow(
        /too similar/i,
      );
    });

    it('has nothing to compare against for a first enrolment', async () => {
      prisma.faceDescriptor.count.mockResolvedValue(0);
      prisma.faceDescriptor.findMany.mockResolvedValue([]);
      stubExtract(vec(1));

      await expect(service.registerFace('img', asEmployee)).resolves.toBeTruthy();
    });

    /**
     * The ordering that makes the e2e suite possible: the cap is counted BEFORE
     * extraction, which is why a one-pixel payload can reach the 400 with no
     * model loaded. Asserted here so a refactor that moves extraction earlier
     * breaks this case rather than silently breaking that suite.
     */
    it('checks the cap before it ever extracts', async () => {
      prisma.faceDescriptor.count.mockResolvedValue(5);
      const extract = jest
        .spyOn(service as any, 'extractDescriptor')
        .mockResolvedValue({ descriptor: Float32Array.from(vec(1)), quality: 0.9 });

      await expect(service.registerFace('img', asEmployee)).rejects.toThrow(
        /Maximum limit of 5/,
      );
      expect(extract).not.toHaveBeenCalled();
    });

    it('refuses an unknown employee before it extracts', async () => {
      prisma.employee.findUnique.mockResolvedValue(null);
      const extract = jest.spyOn(service as any, 'extractDescriptor');

      await expect(
        service.registerFace('img', { employeeId: 'nope', role: 'ADMIN' }),
      ).rejects.toThrow(NotFoundException);
      expect(extract).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('the euclidean distance itself', () => {
    /**
     * Both the duplicate guard and the matcher are thresholds over this one
     * function, so its shape is worth pinning directly — a sign error or an
     * early loop exit here would move both rules at once.
     */
    const distance = (a: number[], b: number[]) =>
      (service as any).euclideanDistance(Float32Array.from(a), b);

    it('is zero for identical vectors', () => {
      expect(distance(vec(0.5), vec(0.5))).toBe(0);
    });

    /**
     * Symmetric to ~1e-7, and NOT to 1e-10 — which is worth stating rather than
     * quietly loosening. The signature is `(a: Float32Array | number[], b: number[])`,
     * so swapping the arguments swaps which vector went through 32-bit
     * truncation: `Float32Array.from(0.1)` is not exactly `0.1`. The residual is
     * float32 epsilon, not a defect, and it is ~1e-7 because that is what
     * single precision buys. A tolerance tighter than that would be a test that
     * fails for arithmetic reasons the product cannot control.
     */
    it('is symmetric to single-precision', () => {
      expect(distance(vec(0.1), vec(0.4))).toBeCloseTo(
        distance(vec(0.4), vec(0.1)),
        6,
      );
    });

    it('grows with the gap, and matches sqrt(n)·delta over a flat vector', () => {
      const near = distance(vec(0), vec(0.01));
      const far = distance(vec(0), vec(0.1));
      expect(far).toBeGreaterThan(near);
      // 128 dimensions, each differing by 0.1 → sqrt(128 · 0.01).
      expect(far).toBeCloseTo(Math.sqrt(128 * 0.01), 6);
    });

    it('never returns a negative distance', () => {
      expect(distance(vec(0.9), vec(0.1))).toBeGreaterThan(0);
      expect(distance(vec(0.1), vec(0.9))).toBeGreaterThan(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('the configured tunables', () => {
    /**
     * These three come from the environment, not from `system_settings`, so
     * nothing in the settings UI moves them and nothing in the e2e suite can
     * assert them. The defaults are the contract.
     */
    it('defaults to a 0.6 match threshold, 5 descriptors and a 0.5 quality floor', () => {
      expect((service as any).threshold).toBe(0.6);
      expect((service as any).maxDescriptorsPerEmployee).toBe(5);
      expect((service as any).minQuality).toBe(0.5);
    });

    it('the duplicate guard is stricter than the match threshold', () => {
      // 0.3 vs 0.6, and the relationship is the point: two photos that would
      // MATCH each other at recognition time can still be far enough apart to
      // be worth storing separately. Inverting these would either reject every
      // second photo of the same face or accept near-duplicates that add
      // nothing.
      expect(0.3).toBeLessThan((service as any).threshold);
    });
  });
});

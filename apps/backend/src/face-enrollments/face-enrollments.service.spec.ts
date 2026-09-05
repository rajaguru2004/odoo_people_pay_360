import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { FaceEnrollmentsService } from './face-enrollments.service';
import { DEFAULT_MATCH_THRESHOLD } from './face-match.util';

const WIDTH = 128;
const AISHA = '11111111-1111-4111-8111-111111111111';

const prismaMock = () => ({
  faceEnrollment: { findMany: jest.fn() },
  employee: { findUnique: jest.fn() },
});

const settingsMock = () => ({ getNumber: jest.fn() });

type PrismaMock = ReturnType<typeof prismaMock>;
type SettingsMock = ReturnType<typeof settingsMock>;

interface EnrollmentWhere {
  isActive?: boolean;
  employeeId?: string;
}

/** The `where` a mocked Prisma call received, typed for the assertion. */
function whereOf(mock: jest.Mock, call = 0): EnrollmentWhere {
  const args = mock.mock.calls as Array<[{ where: EnrollmentWhere }]>;
  return args[call][0].where;
}

/** A template `offset` away from the probe in exactly one dimension. */
function templateAt(offset: number): number[] {
  const descriptor = new Array<number>(WIDTH).fill(0);
  descriptor[0] = offset;
  return descriptor;
}

const PROBE = templateAt(0);

function enrolment(offset: number, employeeId = AISHA) {
  return {
    employeeId,
    descriptor: templateAt(offset),
    quality: 0.91,
    employee: {
      id: employeeId,
      employeeCode: 'EMP-0001',
      firstName: 'Aisha',
      lastName: 'Al Balushi',
      avatarUrl: null,
      status: 'ACTIVE',
    },
  };
}

describe('FaceEnrollmentsService', () => {
  let prisma: PrismaMock;
  let settings: SettingsMock;
  let service: FaceEnrollmentsService;

  beforeEach(() => {
    prisma = prismaMock();
    settings = settingsMock();
    service = new FaceEnrollmentsService(
      prisma as unknown as PrismaService,
      settings as unknown as SystemSettingsService,
    );
    prisma.employee.findUnique.mockResolvedValue({ id: AISHA });
    settings.getNumber.mockResolvedValue(DEFAULT_MATCH_THRESHOLD);
  });

  describe('verify', () => {
    it('names the person on a confident match', async () => {
      prisma.faceEnrollment.findMany.mockResolvedValue([enrolment(0.2)]);

      const result = await service.verify({ descriptor: PROBE });

      expect(result).toMatchObject({
        matched: true,
        employeeId: AISHA,
        confidence: 80,
        threshold: DEFAULT_MATCH_THRESHOLD,
        candidates: 1,
      });
      expect(result.employee?.fullName).toBe('Aisha Al Balushi');
    });

    it('names nobody when the closest candidate misses the threshold', async () => {
      prisma.faceEnrollment.findMany.mockResolvedValue([enrolment(0.85)]);

      const result = await service.verify({ descriptor: PROBE });

      expect(result.matched).toBe(false);
      expect(result.employee).toBeNull();
      // Deliberately silent about WHO was nearly matched. "You are 15% like
      // Aisha" is a fact about Aisha, and the person at the terminal is not
      // entitled to it.
      expect(JSON.stringify(result)).not.toContain('Aisha');
      expect(result.confidence).toBeNull();
      expect(result.distance).toBeNull();
    });

    it('distinguishes "nobody is enrolled" from "nobody was close enough"', async () => {
      prisma.faceEnrollment.findMany.mockResolvedValue([]);

      await expect(
        service.verify({ descriptor: PROBE }),
      ).resolves.toMatchObject({ matched: false, candidates: 0 });
    });

    it('reads the threshold from system settings rather than a constant', async () => {
      prisma.faceEnrollment.findMany.mockResolvedValue([enrolment(0.7)]);
      settings.getNumber.mockResolvedValue(0.8);

      await expect(
        service.verify({ descriptor: PROBE }),
      ).resolves.toMatchObject({ matched: true, threshold: 0.8 });
      expect(settings.getNumber).toHaveBeenCalledWith(
        'face_recognition_match_threshold',
        DEFAULT_MATCH_THRESHOLD,
      );
    });

    it('never returns a stored descriptor, matched or not', async () => {
      prisma.faceEnrollment.findMany.mockResolvedValue([enrolment(0.1)]);
      const matched = await service.verify({ descriptor: PROBE });

      prisma.faceEnrollment.findMany.mockResolvedValue([enrolment(1.4)]);
      const missed = await service.verify({ descriptor: PROBE });

      for (const result of [matched, missed]) {
        expect(JSON.stringify(result)).not.toContain('descriptor');
      }
    });

    it('narrows to one person when the terminal already knows who is there', async () => {
      prisma.faceEnrollment.findMany.mockResolvedValue([enrolment(0.2)]);

      await service.verify({ descriptor: PROBE, employeeId: AISHA });

      expect(whereOf(prisma.faceEnrollment.findMany)).toMatchObject({
        isActive: true,
        employeeId: AISHA,
      });
    });

    it('considers active enrolments only', async () => {
      prisma.faceEnrollment.findMany.mockResolvedValue([enrolment(0.2)]);

      await service.verify({ descriptor: PROBE });

      expect(whereOf(prisma.faceEnrollment.findMany).isActive).toBe(true);
    });
  });

  describe('statusFor', () => {
    it('answers for a user with no employee record instead of failing', async () => {
      await expect(service.statusFor(null)).resolves.toMatchObject({
        isRegistered: false,
        totalRegistered: 0,
        bestQuality: null,
      });
      expect(prisma.faceEnrollment.findMany).not.toHaveBeenCalled();
    });

    it('reports the best capture held, not the most recent one', async () => {
      // Matching uses whichever template is nearest, so the figure that means
      // anything to the person reading it is the best one on file.
      prisma.faceEnrollment.findMany.mockResolvedValue([
        { quality: 0.62, createdAt: new Date('2026-09-01T00:00:00.000Z') },
        { quality: 0.94, createdAt: new Date('2026-06-01T00:00:00.000Z') },
      ]);

      await expect(service.statusFor(AISHA)).resolves.toMatchObject({
        isRegistered: true,
        totalRegistered: 2,
        bestQuality: 0.94,
        lastEnrolledAt: new Date('2026-09-01T00:00:00.000Z'),
      });
    });
  });
});

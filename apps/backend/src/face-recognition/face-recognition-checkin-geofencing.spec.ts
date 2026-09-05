import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { FaceRecognitionService } from './face-recognition.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { AttendancesService } from '../attendances/attendances.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';

/**
 * Verifies that geofencing coordinates captured by the browser are actually
 * forwarded from the face-recognition check-in paths into
 * AttendancesService.checkIn(), which is where the geofence is enforced.
 * Face matching itself (extractDescriptor/findBestMatch) is stubbed since it
 * depends on real image bytes and loaded ML models — out of scope here.
 */
describe('FaceRecognitionService - geofencing coords passthrough', () => {
  let service: FaceRecognitionService;
  let mockAttendancesService: { checkIn: jest.Mock };

  const coords = { latitude: 13.0827, longitude: 80.2707, accuracy: 10 };

  beforeEach(async () => {
    mockAttendancesService = {
      checkIn: jest.fn().mockResolvedValue({
        success: true,
        message: 'Checked in successfully',
        data: { id: 'att-1' },
      }),
    };

    /**
     * Key-aware, because a blanket `'true'` is not a faithful settings service.
     * It used to be harmless — nothing on this path read a switch — but
     * `captureCheckIn` now refuses when `attendance_face_only` is ON while the
     * matcher is still enabled (capture-only is the FALLBACK for a disabled
     * matcher, never a bypass of an enabled one). A mock that answers 'true' to
     * every key therefore turned every capture into a refusal.
     *
     * These are the production defaults; the switch itself is covered by
     * `attendance-face.e2e-spec.ts` against real `system_settings` rows.
     */
    const mockSystemSettingsService: Partial<SystemSettingsService> = {
      getSetting: jest.fn(async (key: string, fallback?: string) => {
        if (key === 'attendance_face_only') return 'false';
        if (key === 'face_recognition_enabled') return 'true';
        return fallback ?? 'true';
      }) as any,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FaceRecognitionService,
        { provide: PrismaService, useValue: {} },
        { provide: StorageService, useValue: {} },
        { provide: AttendancesService, useValue: mockAttendancesService },
        { provide: ConfigService, useValue: { get: jest.fn((_key, def) => def) } },
        { provide: SystemSettingsService, useValue: mockSystemSettingsService },
      ],
    }).compile();

    service = module.get(FaceRecognitionService);

    // Stub out real face-matching internals — not under test here.
    jest.spyOn(service as any, 'extractDescriptor').mockResolvedValue({
      descriptor: new Float32Array([0.1, 0.2, 0.3]),
      quality: 0.9,
    });
    jest.spyOn(service as any, 'findBestMatch').mockResolvedValue({
      employeeId: 'emp-1',
      employee: {
        id: 'emp-1',
        fullName: 'Jane Doe',
        employeeCode: 'EMP001',
        avatarUrl: null,
      },
      distance: 0.2,
    });
    jest.spyOn(service as any, 'uploadAttendanceImage').mockResolvedValue(undefined);
  });

  it('faceCheckIn() forwards coords to attendancesService.checkIn as byFace=true', async () => {
    await service.faceCheckIn('data:image/jpeg;base64,xyz', 'emp-1', coords);
    expect(mockAttendancesService.checkIn).toHaveBeenCalledWith('emp-1', true, coords);
  });

  it('faceCheckIn() works with no coords (geofencing disabled) — undefined passthrough', async () => {
    await service.faceCheckIn('data:image/jpeg;base64,xyz', 'emp-1');
    expect(mockAttendancesService.checkIn).toHaveBeenCalledWith('emp-1', true, undefined);
  });

  it('captureCheckIn() forwards coords to attendancesService.checkIn as byFace=true', async () => {
    await service.captureCheckIn('data:image/jpeg;base64,xyz', 'emp-1', coords);
    expect(mockAttendancesService.checkIn).toHaveBeenCalledWith('emp-1', true, coords);
  });

  it('propagates a geofence rejection from attendancesService.checkIn (out of office)', async () => {
    mockAttendancesService.checkIn.mockRejectedValueOnce(
      new Error('You are out of office range (500m away, allowed 100m). Check-in denied.'),
    );
    await expect(
      service.faceCheckIn('data:image/jpeg;base64,xyz', 'emp-1', coords),
    ).rejects.toThrow('You are out of office range');
  });
});

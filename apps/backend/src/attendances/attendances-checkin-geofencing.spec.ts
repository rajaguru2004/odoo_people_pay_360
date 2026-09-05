import { Test, TestingModule } from '@nestjs/testing';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import request from 'supertest';
import { AttendancesController } from './attendances.controller';
import { AttendancesService } from './attendances.service';
import { AttendanceHubService } from './attendance-hub.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { TimezoneService } from '../common/timezone/timezone.service';
import { MailService } from '../mail/mail.service';
import { HolidaysService } from '../holidays/holidays.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

/**
 * Full HTTP-layer coverage for geofenced check-in: real ValidationPipe
 * (whitelist/forbidNonWhitelisted/transform, matching main.ts), real
 * RolesGuard, real AttendancesController + AttendancesService wiring.
 * Only Prisma/SystemSettings/Timezone/Mail are faked, and JwtAuthGuard is
 * swapped for a fake that injects `req.user` (avoids needing a real
 * passport-jwt strategy registered).
 */
describe('Attendances check-in geofencing (HTTP)', () => {
  let app: INestApplication;
  let mockPrisma: any;
  let geofencePolicy: {
    enabled: boolean;
    officeLat: number | null;
    officeLng: number | null;
    radiusMeters: number;
  };
  let currentUser: { role: string; employeeId: string };

  class FakeJwtAuthGuard implements CanActivate {
    canActivate(context: ExecutionContext) {
      const req = context.switchToHttp().getRequest();
      req.user = currentUser;
      return true;
    }
  }

  beforeEach(async () => {
    currentUser = { role: 'EMPLOYEE', employeeId: 'emp-1' };
    geofencePolicy = {
      enabled: false,
      officeLat: null,
      officeLng: null,
      radiusMeters: 100,
    };

    mockPrisma = {
      employee: {
        findUnique: jest.fn().mockResolvedValue({ id: 'emp-1', timezone: null }),
      },
      attendance: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest
          .fn()
          .mockImplementation(({ data }: any) => Promise.resolve({ id: 'att-1', ...data })),
        update: jest
          .fn()
          .mockImplementation(({ data }: any) => Promise.resolve({ id: 'att-1', ...data })),
      },
      workSchedule: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };

    const mockSettings: any = {
      getSetting: jest.fn().mockImplementation((key: string, fallback: string) => {
        const defaults: Record<string, string> = {
          office_start_time: '08:30',
          office_end_time: '17:30',
          system_timezone: 'Asia/Kolkata',
          attendance_face_only: 'false',
          allow_multiple_checkin: 'false',
        };
        return Promise.resolve(defaults[key] ?? fallback);
      }),
      getGeofencingPolicy: jest.fn().mockImplementation(() => Promise.resolve(geofencePolicy)),
      // The service resolves office hours through the branch-aware door now;
      // this spec has no branch, so it serves the same globals its `getSetting`
      // above does.
      getOfficeHours: jest
        .fn()
        .mockImplementation(() =>
          Promise.resolve({ start: '08:30', end: '17:30' }),
        ),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AttendancesController],
      providers: [
        AttendancesService,
        // The controller takes it, but nothing in this file drives the hub —
        // an empty stand-in keeps the geofencing cases about geofencing.
        { provide: AttendanceHubService, useValue: {} },
        { provide: PrismaService, useValue: mockPrisma },
        { provide: SystemSettingsService, useValue: mockSettings },
        { provide: TimezoneService, useValue: new TimezoneService(mockSettings) },
        { provide: MailService, useValue: {} },
        {
          provide: HolidaysService,
          useValue: {
            getWorkingDatesBetween: jest.fn(async (s: Date) => [s]),
            getWorkDaysBetween: jest.fn(async () => 22),
            getWorkDaysInMonth: jest.fn(async () => 22),
            isHoliday: jest.fn(async () => false),
            getHolidaysInRange: jest.fn(async () => []),
          },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(new FakeJwtAuthGuard())
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('checks in with no body when geofencing is disabled', async () => {
    const res = await request(app.getHttpServer())
      .post('/attendances/check-in')
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(mockPrisma.attendance.create).toHaveBeenCalled();
  });

  it('rejects (400) when geofencing is enabled and no coords are sent', async () => {
    geofencePolicy.enabled = true;
    geofencePolicy.officeLat = 13.0827;
    geofencePolicy.officeLng = 80.2707;

    const res = await request(app.getHttpServer())
      .post('/attendances/check-in')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Location access is required/);
    expect(mockPrisma.attendance.create).not.toHaveBeenCalled();
  });

  it('rejects (400) when geofencing is enabled but office location is unset', async () => {
    geofencePolicy.enabled = true;

    const res = await request(app.getHttpServer())
      .post('/attendances/check-in')
      .send({ latitude: 13.0827, longitude: 80.2707 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/office location has not been configured/);
  });

  it('rejects (403) when coords are outside the configured radius', async () => {
    geofencePolicy.enabled = true;
    geofencePolicy.officeLat = 13.0827;
    geofencePolicy.officeLng = 80.2707;
    geofencePolicy.radiusMeters = 100;

    const res = await request(app.getHttpServer())
      .post('/attendances/check-in')
      .send({ latitude: 13.0927, longitude: 80.2707 }); // ~1.1km away
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/out of office range/);
    expect(mockPrisma.attendance.create).not.toHaveBeenCalled();
  });

  it('succeeds (201) and persists coords when inside the radius', async () => {
    geofencePolicy.enabled = true;
    geofencePolicy.officeLat = 13.0827;
    geofencePolicy.officeLng = 80.2707;
    geofencePolicy.radiusMeters = 100;

    const res = await request(app.getHttpServer())
      .post('/attendances/check-in')
      .send({ latitude: 13.0827, longitude: 80.2707, accuracy: 12.5 });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);

    const createArgs = mockPrisma.attendance.create.mock.calls[0][0];
    expect(createArgs.data.checkInLatitude).toBe(13.0827);
    expect(createArgs.data.checkInLongitude).toBe(80.2707);
    expect(createArgs.data.checkInAccuracy).toBe(12.5);
  });

  it('rejects (400) an out-of-range latitude at the DTO validation layer, before business logic runs', async () => {
    const res = await request(app.getHttpServer())
      .post('/attendances/check-in')
      .send({ latitude: 999, longitude: 80.2707 });
    expect(res.status).toBe(400);
    // Never reaches the service/geofence logic — rejected by class-validator's @Max(90).
    expect(mockPrisma.employee.findUnique).not.toHaveBeenCalled();
  });

  it('rejects (400) a request body with an unexpected extra field (forbidNonWhitelisted)', async () => {
    const res = await request(app.getHttpServer())
      .post('/attendances/check-in')
      .send({ latitude: 13.0827, longitude: 80.2707, notAField: 'nope' });
    expect(res.status).toBe(400);
  });

  it('HR-triggered check-in bypasses geofencing even when enabled and coords are out of range', async () => {
    currentUser = { role: 'ADMIN', employeeId: 'admin-1' };
    geofencePolicy.enabled = true;
    geofencePolicy.officeLat = 13.0827;
    geofencePolicy.officeLng = 80.2707;
    geofencePolicy.radiusMeters = 100;

    const res = await request(app.getHttpServer())
      .post('/attendances/check-in/emp-1')
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    const createArgs = mockPrisma.attendance.create.mock.calls[0][0];
    expect(createArgs.data.checkInLatitude).toBeNull();
  });

  it('rejects (403) an EMPLOYEE hitting the HR-only check-in-for-employee route', async () => {
    currentUser = { role: 'EMPLOYEE', employeeId: 'emp-1' };

    const res = await request(app.getHttpServer())
      .post('/attendances/check-in/emp-2')
      .send({});
    expect(res.status).toBe(403);
    expect(mockPrisma.attendance.create).not.toHaveBeenCalled();
  });
});

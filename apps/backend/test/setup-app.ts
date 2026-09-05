import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/http-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';

/**
 * Boot the real application the way `main.ts` boots it.
 *
 * The pipe, interceptor and filter are not optional garnish here: half of what
 * these specs assert IS the envelope and the 400-on-unknown-field behaviour, so
 * an app assembled without them would pass tests that the running server fails.
 */
export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalInterceptors(new TransformInterceptor());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  return app;
}

export interface Session {
  token: string;
  auth: (req: request.Test) => request.Test;
}

/**
 * Sign in as one of the seeded accounts.
 *
 * The specs speak in roles rather than in tokens because what they are actually
 * testing is the guard: "an employee cannot reach this" is the assertion, and a
 * bare token string in the test body hides which principal it belongs to.
 */
export async function signIn(
  app: INestApplication,
  email: string,
  password = 'Admin@123',
): Promise<Session> {
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password })
    .expect(201);

  const token = res.body.data.accessToken as string;
  return {
    token,
    auth: (req) => req.set('Authorization', `Bearer ${token}`),
  };
}

export const ACCOUNTS = {
  admin: 'admin@peoplepay360.com',
  hr: 'hr@peoplepay360.com',
  payroll: 'payroll@peoplepay360.com',
  employee: 'employee@peoplepay360.com',
} as const;

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';

/**
 * NOTE ON ISOLATION
 *
 * These specs write to the e2e database and some of what they write is
 * HISTORY that the application deliberately does not delete — an approved
 * change request, a renewed permit. Re-running them accumulates that history,
 * which is correct behaviour and harmless, but it means no assertion here or
 * in the browser suite may depend on a whole-table count.
 *
 * Start from a clean slate with `npm run e2e:db reset` (which drops the
 * container) rather than `npm run e2e:up` (which only re-seeds a database that
 * is already running).
 */

/**
 * Smoke test for the wiring, not for the domain.
 *
 * Needs the test database up: `npm run e2e:up` from the repo root, with
 * apps/backend/.env.test loaded.
 */
describe('Health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalInterceptors(new TransformInterceptor());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET /health reports ok inside the standard envelope', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body).toMatchObject({ success: true, data: { status: 'ok' } });
  });

  it('GET /auth/me without a token is rejected', () =>
    request(app.getHttpServer()).get('/auth/me').expect(401));
});

import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { json, urlencoded } from 'express';
import request = require('supertest');
import { TestAppModule } from './test-app.module';
import { AllExceptionsFilter } from '../../src/common/filters/http-exception.filter';
import { PrismaService } from '../../src/prisma/prisma.service';
import { assertTestDatabase } from './assert-test-database';

export interface E2EContext {
  app: INestApplication;
  prisma: PrismaService;
  http: () => ReturnType<typeof request>;
}

/**
 * Boots the real AppModule with the same global pipes/filters as production
 * (src/main.ts), so e2e tests exercise the true request pipeline —
 * middleware -> guards -> BranchContextInterceptor -> handler -> Prisma $use.
 */
export async function bootE2EApp(): Promise<E2EContext> {
  // Before anything is constructed, and long before a connection is opened:
  // this suite writes and deletes real rows, and it reads its target from the
  // same `.env` that has pointed at production before. `ConfigModule.forRoot()`
  // takes no `envFilePath`, so it loads whatever `.env` happens to hold.
  // `jest-e2e.json` runs the same check as globalSetup — which also covers the
  // specs that boot `TestAppModule` directly instead of coming through here;
  // this call covers a boot from outside jest.
  //
  // An earlier guard on main allow-listed hosts by string match, including
  // 192.168.0.141:8069 and 80.225.236.50:8068. Both are real tenants — the
  // Nexura/Muscat demo behind demo.ess.tools.thefusionapps.com is data people
  // are using — so that list would have let a suite truncate production. The
  // rule here is the loopback-only one that scripts/e2e-db.sh and
  // .github/workflows/pr.yml already enforce; see assert-test-database.ts.
  assertTestDatabase();

  const moduleRef = await Test.createTestingModule({
    imports: [TestAppModule],
  }).compile();

  const app = moduleRef.createNestApplication({ bodyParser: false });

  // Match src/main.ts. Without this the suite runs on Nest's 100kb default, so a
  // request that production accepts is rejected here before it ever reaches
  // validation — and the failure surfaces as a 500, not the 400 the DTO defines.
  app.use(json({ limit: '1mb' }));
  app.use(urlencoded({ extended: true, limit: '1mb' }));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();

  const prisma = app.get(PrismaService);
  return {
    app,
    prisma,
    http: () => request(app.getHttpServer()),
  };
}

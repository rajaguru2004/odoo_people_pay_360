import { Test } from '@nestjs/testing';
import { Module, INestApplication, ValidationPipe } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { json, urlencoded } from 'express';
import request = require('supertest');
import { TestAppModule } from './test-app.module';
import { FaceRecognitionModule } from '../../src/face-recognition/face-recognition.module';
import { AllExceptionsFilter } from '../../src/common/filters/http-exception.filter';
import { PrismaService } from '../../src/prisma/prisma.service';
import { E2EContext } from './e2e-app';

/**
 * A second boot helper, for the one module `TestAppModule` deliberately excludes.
 *
 * `FaceRecognitionModule` is left out of the shared slice because loading the
 * TensorFlow + face-api models costs every suite several seconds it does not
 * need. That exclusion is correct, but it left the entire `/face-recognition/*`
 * surface answering 404 in e2e rather than failing honestly — the same class of
 * harness lie the People phase found in `assertDevDb`.
 *
 * ── Why this works without a model ──────────────────────────────────────────
 *
 * Three facts, each read out of `face-recognition.service.ts`:
 *
 *   1. The module's `require` of face-api and its `faceapi.env.monkeyPatch` are
 *      plain JavaScript at import time. They do NOT load a model, and all three
 *      packages are present in `node_modules`. Importing the module is cheap.
 *   2. TensorFlow is required LAZILY, inside `loadModels()`.
 *   3. `loadModels()` runs from `onModuleInit` ONLY when
 *      `face_recognition_enabled !== 'false'` (L59-75), and otherwise logs
 *      "Face recognition disabled in system settings — skipping model load".
 *
 * So writing that setting to `'false'` BEFORE `Test.compile()` gives a fully
 * wired controller + service + real database with no model in memory. Note the
 * ordering requirement is real: `onModuleInit`'s `catch` arm falls back to
 * `loadModels()` if the settings read throws, so the row must already be there.
 *
 * ── What that reaches, and what it does not ─────────────────────────────────
 *
 * Reachable (the answer is returned BEFORE `extractDescriptor` is called, or the
 * path never touches the model at all):
 *   - the descriptor cap 400          — counted at L221-227, before L232
 *   - cross-employee register 400     — role check at L204-211
 *   - unknown-employee 404            — L215-219
 *   - GET status / descriptors/me / descriptors/:employeeId, DELETE by id
 *   - the four `capture-*` endpoints  — no matching at all
 *   - every `@Roles` denial           — RolesGuard runs before the handler body
 *
 * NOT reachable, and deliberately not attempted here:
 *   - the duplicate guard (euclidean < 0.3), the `FACE_RECOGNITION_MIN_QUALITY`
 *     floor, the 0.6 match threshold, and any successful self-register — all of
 *     which run after extraction. Those are pure arithmetic over a 128-float
 *     array and belong in `src/face-recognition/face-recognition.service.spec.ts`
 *     with `extractDescriptor` stubbed.
 *
 * Face MATCHING ACCURACY is out of scope for this phase entirely.
 *
 * The pipes, filters and body limits below are copied from `bootE2EApp` rather
 * than shared, and they must stay identical — a divergence would mean the face
 * spec tests a different request pipeline from every other spec in the suite.
 */
@Module({ imports: [TestAppModule, FaceRecognitionModule] })
export class FaceTestAppModule {}

export interface FaceE2EContext extends E2EContext {
  /** Puts `face_recognition_enabled` back as it was found. Call in `afterAll`. */
  restoreFlag: () => Promise<void>;
}

export async function bootFaceE2EApp(): Promise<FaceE2EContext> {
  // A bare client, because the setting has to be written before Nest compiles
  // and there is no PrismaService to borrow yet.
  const bootstrap = new PrismaClient();
  let previous: string | null = null;
  try {
    const row = await bootstrap.systemSetting.findUnique({
      where: { key: 'face_recognition_enabled' },
    });
    previous = row?.value ?? null;
    await bootstrap.systemSetting.upsert({
      where: { key: 'face_recognition_enabled' },
      create: { key: 'face_recognition_enabled', value: 'false' },
      update: { value: 'false' },
    });
  } finally {
    await bootstrap.$disconnect();
  }

  const moduleRef = await Test.createTestingModule({
    imports: [FaceTestAppModule],
  }).compile();

  const app = moduleRef.createNestApplication({ bodyParser: false });

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
    restoreFlag: async () => {
      // `null` means the row did not exist, which is not the same as an empty
      // value — restoring it has to DELETE, not write. Same contract as
      // `restoreSetting` in ./settings.
      if (previous === null) {
        await prisma.systemSetting
          .delete({ where: { key: 'face_recognition_enabled' } })
          .catch(() => undefined);
        return;
      }
      await prisma.systemSetting.update({
        where: { key: 'face_recognition_enabled' },
        data: { value: previous },
      });
    },
  };
}

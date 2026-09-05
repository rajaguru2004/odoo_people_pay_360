/**
 * CLI wrapper for the comprehensive SAMPLE dataset seed.
 *
 * The actual seeding logic lives in the Nest `SampleDataService` (single source
 * of truth, shared with the UI-triggered seed). This script just bootstraps a
 * minimal Nest context and invokes it.
 *
 * Run:  npm run prisma:seed:sample   (from apps/backend)
 */

import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DevModeModule } from '../src/dev-mode/dev-mode.module';
import { SampleDataModule } from '../src/sample-data/sample-data.module';
import { SampleDataService } from '../src/sample-data/sample-data.service';

/**
 * `DevModeModule` is @Global, so nothing that needs `DevModeService` imports it
 * explicitly — it is registered once by `AppModule`. This context is not
 * AppModule, so without it the controllers pulled in transitively cannot
 * resolve `DevModeGuard` and the whole seed dies at bootstrap:
 * "Nest can't resolve dependencies of the DevModeGuard (Reflector, ?)".
 */
@Module({ imports: [ConfigModule.forRoot({ isGlobal: true }), DevModeModule, SampleDataModule] })
class CliSampleSeedModule {}

async function main() {
  console.log('🌱 Seeding comprehensive SAMPLE dataset...');
  const app = await NestFactory.createApplicationContext(CliSampleSeedModule, { logger: ["error", "warn"] });
  const svc = app.get(SampleDataService);
  const { counts } = await svc.seedSample((u) => {
    if (u.type === 'step') console.log(`  • ${u.message}`);
  });
  await app.close();
  console.log('✅ Sample seeding complete:');
  console.table(counts);
}

main()
  .catch((e) => {
    console.error('❌ Sample seeding failed:', e);
    process.exit(1);
  })
  .finally(() => process.exit(0));

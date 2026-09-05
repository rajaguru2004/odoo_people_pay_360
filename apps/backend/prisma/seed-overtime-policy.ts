/**
 * Idempotent bootstrap for the Overtime Policy engine.
 *
 * Ensures a "Company Default" overtime policy exists whose rules mirror the
 * current global overtime settings, so that turning on the `overtime_policy_enabled`
 * kill-switch changes NOTHING until an admin adds a targeted policy. Safe to run
 * repeatedly (no-op when an active default already exists).
 *
 * Run (from apps/backend), pointing at the DEV/test database — never PROD:
 *   DATABASE_URL="postgresql://…/myappdb?schema=public" npm run prisma:seed:overtime-policy
 */

import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { OvertimePolicyModule } from '../src/overtime-policy/overtime-policy.module';
import { OvertimePolicyService } from '../src/overtime-policy/overtime-policy.service';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), OvertimePolicyModule],
})
class CliOvertimePolicySeedModule {}

async function main() {
  console.log('🌱 Ensuring Company Default overtime policy…');
  const app = await NestFactory.createApplicationContext(
    CliOvertimePolicySeedModule,
    { logger: false },
  );
  const svc = app.get(OvertimePolicyService);
  const result = await svc.ensureCompanyDefault();
  await app.close();

  if (result.created) {
    console.log(`✅ Created Company Default policy (${result.policyId}).`);
  } else {
    console.log(
      `✅ Company Default already present (${result.policyId}) — no changes.`,
    );
  }
  console.log(
    'ℹ️  Flip overtime_policy_enabled = true in Settings to engage the policy engine.',
  );
}

main().catch((e) => {
  console.error('❌ Overtime policy seed failed:', e);
  process.exit(1);
});

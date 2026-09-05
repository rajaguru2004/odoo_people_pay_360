/**
 * CLI wrapper for the Singapore Overtime → Payroll demo seed.
 *
 * Seeds 2 employees + attendance + overtime (all otTypes) + food allowance for
 * the CURRENT month, driving the real request → approve → payroll-generation
 * cycle. Override the period with DEMO_MONTH / DEMO_YEAR.
 *
 * Run (from apps/backend), pointing at the DEV/test database — never PROD:
 *   DATABASE_URL="postgresql://postgres:postgres@80.225.236.50:8068/myappdb?schema=public" \
 *     npm run prisma:seed:demo-ot
 *
 * The npm script pins TZ=UTC so the deferred local-time day classification in
 * OvertimeService resolves the demo dates (the chosen Sunday & public holiday).
 */

import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DemoOvertimeModule } from '../src/demo-overtime/demo-overtime.module';
import { DemoOvertimeService } from '../src/demo-overtime/demo-overtime.service';

@Module({ imports: [ConfigModule.forRoot({ isGlobal: true }), DemoOvertimeModule] })
class CliDemoOtSeedModule {}

async function main() {
  console.log('🌱 Seeding Singapore Overtime → Payroll demo (current month)…');
  const app = await NestFactory.createApplicationContext(CliDemoOtSeedModule, { logger: false });
  const svc = app.get(DemoOvertimeService);
  const { summary, allOk, branch, period, scenarioDates } = await svc.seedDemo((m) => console.log(`  • ${m}`));
  await app.close();
  console.log(`\n🗓  Overtime scenarios (${period}):`);
  for (const s of scenarioDates) console.log(`   - ${s}`);
  console.log(`\n📊 Payroll result — ${period} — ${branch}:`);
  console.table(summary);
  if (allOk) {
    console.log('✅ Demo ready — OT pay & food allowance match expectations.');
  } else {
    console.log('❌ OT/food figures diverged from expectations — check the table above.');
  }
}

main()
  .catch((e) => {
    console.error('❌ Demo-OT seeding failed:', e);
    process.exit(1);
  })
  .finally(() => process.exit(0));

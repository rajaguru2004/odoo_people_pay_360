/**
 * Idempotent seed for the "Daily Wage OT" overtime policy.
 *
 * Clones the Company Default overtime rules (rates/thresholds/allowances/caps),
 * but sets holidayBehavior = IGNORE and targets the DAILY_WAGE employment type —
 * so daily-wage employees' overtime is calculated WITHOUT considering National
 * Holidays, while everyone else keeps the standard rules. Safe to run twice
 * (skips if an active DAILY_WAGE policy already exists).
 *
 * Run (from apps/backend), pointing at the target database:
 *   npm run prisma:seed:daily-wage-policy
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
class CliDailyWagePolicySeedModule {}

async function main() {
  console.log('🌱 Ensuring "Daily Wage OT" policy (ignores National Holidays)…');
  const app = await NestFactory.createApplicationContext(
    CliDailyWagePolicySeedModule,
    { logger: false },
  );
  const svc = app.get(OvertimePolicyService);

  // Idempotency: skip if an active policy already targets the Daily Wage type.
  const { data: existing } = await svc.list();
  const already = existing.find(
    (p) => p.isActive && p.employmentType === 'Daily Wage',
  );
  if (already) {
    await app.close();
    console.log(
      `✅ An active DAILY_WAGE policy already exists ("${already.name}", ${already.id}) — no changes.`,
    );
    return;
  }

  const { data: policy } = await svc.create({
    name: 'Daily Wage OT',
    description:
      'Overtime for daily-wage staff. Same rates as the Company Default, but National Holidays are treated as ordinary working days (holidayBehavior = IGNORE).',
    isActive: true,
    isDefault: false,
    // Targets the "Daily Wage" Employment Type library label. Ensure that label
    // exists in the Employment Type library (Settings → Libraries) so employees
    // can be assigned it.
    employmentType: 'Daily Wage',
    // Only override the holiday behaviour; every other rule is composed from the
    // current global overtime settings (i.e. the Company Default rates).
    rules: { holidayBehavior: 'IGNORE' as any },
  });

  await app.close();
  console.log(`✅ Created "Daily Wage OT" policy (${policy.id}).`);
  console.log(
    'ℹ️  Assign employees Employment Type = Daily Wage (employee form / overtime_policy_assign) — the engine resolves it with no switch to flip.',
  );
  console.log(
    'ℹ️  ALSO set those employees Pay Basis = Daily wage (Employee.salaryType = DAILY) and enter their baseSalary as a PER-DAY rate — the OT policy governs rates, salaryType governs how the rate is read.',
  );
}

main().catch((e) => {
  console.error('❌ Daily Wage policy seed failed:', e);
  process.exit(1);
});

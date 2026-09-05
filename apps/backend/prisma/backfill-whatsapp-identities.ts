/**
 * Create WhatsApp delivery-identity CANDIDATES from `Employee.phone`.
 *
 * Important: this backfill never creates consent. Every row is written with
 * `optedIn: false, verified: false`. Consent comes from the employee (profile →
 * WhatsApp) and verification from a real /chat/whatsappNumbers round trip. What
 * this script does is the tedious part — turning free-text HR phone data into
 * E.164 and reporting what could not be parsed.
 *
 * `--dry-run` is the DEFAULT. Nothing is written without `--commit`.
 *
 *   npm run prisma:backfill:whatsapp                # report only
 *   npm run prisma:backfill:whatsapp -- --commit    # write candidates
 *
 * Duplicate numbers across employees are a HARD failure rather than a warning:
 * `whatsapp_identities.phone_e164` is unique because one WhatsApp account must
 * map to exactly one person, and a shared family number would otherwise
 * silently deliver one employee's notifications to another.
 */
import { PrismaClient } from '@prisma/client';
import parsePhoneNumberFromString, { CountryCode } from 'libphonenumber-js';

const prisma = new PrismaClient();

const COMMIT = process.argv.includes('--commit');

/** Same algorithm as src/whatsapp/utils/phone.util.ts, standalone for the script. */
function toE164(raw: string | null | undefined, region?: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[\s\-(). ]/g, '').trim();
  if (!cleaned) return null;
  const candidate = cleaned.startsWith('00') ? `+${cleaned.slice(2)}` : cleaned;
  const country =
    region && /^[A-Z]{2}$/.test(region.toUpperCase())
      ? (region.toUpperCase() as CountryCode)
      : undefined;
  if (!candidate.startsWith('+') && !country) return null;
  const parsed = parsePhoneNumberFromString(candidate, country);
  if (!parsed || !parsed.isValid()) return null;
  const e164 = parsed.number;
  return /^\+[1-9]\d{7,14}$/.test(e164) ? e164 : null;
}

function mask(e164: string): string {
  const digits = e164.replace(/\D/g, '');
  if (digits.length <= 4) return '••••';
  return `+${digits.slice(0, 3)}${'•'.repeat(Math.max(1, digits.length - 7))}${digits.slice(-4)}`;
}

async function main() {
  console.log(`📱 WhatsApp identity backfill (${COMMIT ? 'COMMIT' : 'DRY RUN'})`);
  console.log('   Candidates only — no consent, no verification.\n');

  const globalRegion = (
    await prisma.systemSetting.findUnique({ where: { key: 'whatsapp.defaultRegion' } })
  )?.value?.trim().toUpperCase();
  const payrollCountry = (
    await prisma.systemSetting.findUnique({ where: { key: 'payroll_country' } })
  )?.value?.trim().toUpperCase();

  const employees = await prisma.employee.findMany({
    where: { status: 'ACTIVE', phone: { not: null } },
    select: {
      id: true,
      employeeCode: true,
      fullName: true,
      phone: true,
      branchId: true,
      branch: { select: { code: true, country: true } },
      user: { select: { id: true } },
    },
  });

  const parsed: Array<{
    employeeId: string;
    userId: string;
    branchId: string | null;
    e164: string;
    label: string;
  }> = [];
  const unparseable: string[] = [];
  const noUser: string[] = [];
  const noRegion = new Set<string>();
  const byCountry = new Map<string, number>();

  for (const e of employees) {
    // Branch column -> global whatsapp setting -> payroll_country, the same
    // chain the runtime uses.
    const region = e.branch?.country?.trim().toUpperCase() || globalRegion || payrollCountry || '';
    const e164 = toE164(e.phone, region);

    if (!e164) {
      if (!region && !e.phone?.trim().startsWith('+')) {
        noRegion.add(e.branch?.code ?? '(no branch)');
      }
      unparseable.push(`${e.employeeCode} ${e.fullName}: "${e.phone}" (region ${region || '?'})`);
      continue;
    }
    // Without a user account there is nothing to key a notification off.
    if (!e.user?.id) {
      noUser.push(`${e.employeeCode} ${e.fullName}`);
      continue;
    }

    const cc = e164.slice(0, 4);
    byCountry.set(cc, (byCountry.get(cc) ?? 0) + 1);
    parsed.push({
      employeeId: e.id,
      userId: e.user.id,
      branchId: e.branchId,
      e164,
      label: `${e.employeeCode} ${e.fullName}`,
    });
  }

  // ---- duplicate detection (hard failure) ---------------------------------
  const owners = new Map<string, string[]>();
  for (const p of parsed) {
    owners.set(p.e164, [...(owners.get(p.e164) ?? []), p.label]);
  }
  const duplicates = [...owners.entries()].filter(([, who]) => who.length > 1);

  // ---- report -------------------------------------------------------------
  console.log(`   employees with a phone : ${employees.length}`);
  console.log(`   normalised OK          : ${parsed.length}`);
  console.log(`   unparseable            : ${unparseable.length}`);
  console.log(`   no user account        : ${noUser.length}`);
  console.log(`   duplicate numbers      : ${duplicates.length}`);
  if (byCountry.size) {
    console.log(
      `   by prefix              : ${[...byCountry.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([cc, n]) => `${cc}=${n}`)
        .join(' ')}`,
    );
  }

  if (noRegion.size) {
    console.log(
      `\n⚠️  Branches with no ISO country set (national numbers cannot be normalised): ${[
        ...noRegion,
      ].join(', ')}`,
    );
    console.log('   Set Branch.country before committing, or those employees are skipped.');
  }

  if (unparseable.length) {
    console.log('\n⚠️  Unparseable (fix the HR data, not the normaliser):');
    for (const u of unparseable.slice(0, 40)) console.log(`     - ${u}`);
    if (unparseable.length > 40) console.log(`     ... and ${unparseable.length - 40} more`);
  }

  if (noUser.length) {
    console.log('\nℹ️  Skipped, no user account to notify:');
    for (const u of noUser.slice(0, 20)) console.log(`     - ${u}`);
    if (noUser.length > 20) console.log(`     ... and ${noUser.length - 20} more`);
  }

  if (duplicates.length) {
    console.log('\n❌ Duplicate numbers — these must be resolved in the HR data first:');
    for (const [num, who] of duplicates) {
      console.log(`     - ${mask(num)} shared by: ${who.join(' | ')}`);
    }
    console.log(
      '\n   One WhatsApp account maps to exactly one person, so a shared number would ' +
        'deliver one employee\'s notifications to another. Aborting.',
    );
    process.exitCode = 1;
    return;
  }

  if (!COMMIT) {
    console.log('\n🔍 Dry run. Re-run with --commit to create these candidates.');
    return;
  }

  // ---- write ---------------------------------------------------------------
  let created = 0;
  let skipped = 0;
  for (const p of parsed) {
    // Never touch a row that already exists: it may carry consent that this
    // script has no business resetting.
    const existing = await prisma.whatsAppIdentity.findFirst({
      where: { OR: [{ userId: p.userId }, { phoneE164: p.e164 }] },
    });
    if (existing) {
      skipped++;
      continue;
    }
    await prisma.whatsAppIdentity.create({
      data: {
        userId: p.userId,
        employeeId: p.employeeId,
        branchId: p.branchId,
        phoneE164: p.e164,
        source: 'EMPLOYEE_PHONE',
        optedIn: false,
        verified: false,
      },
    });
    created++;
  }

  console.log(`\n✅ Created ${created} candidate identities (${skipped} already existed).`);
  console.log('   All are optedIn=false, verified=false. Next steps:');
  console.log('     1. Admin → Settings → WhatsApp → "Verify pending numbers"');
  console.log('     2. Employees opt in from Profile → WhatsApp');
}

main()
  .catch((e) => {
    console.error('❌ Backfill failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

/**
 * Idempotent seed for the Oman Bank Master.
 *
 * Seeds the major licensed Omani banks by NAME only. `bankCode` (the 3-char CBO
 * code embedded in Omani IBANs at positions 5-7) is intentionally left null —
 * shipping an unverified code would break IBAN bank-code validation for real
 * accounts. An admin fills each verified code via the Bank Master UI / MCP, at
 * which point IBAN↔bank consistency checking switches on for that bank.
 *
 * Safe to run repeatedly (upsert on country+name).
 *
 * Run (from apps/backend), pointing at the DEV/test database — never PROD:
 *   DATABASE_URL="postgresql://…/myappdb?schema=public" ts-node --transpile-only prisma/seed-oman-banks.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Major licensed banks in Oman. bankCode verified separately by HR/Admin.
const OMAN_BANKS: { name: string; swift?: string }[] = [
  { name: 'Bank Muscat', swift: 'BMUSOMRX' },
  { name: 'National Bank of Oman', swift: 'NBOMOMRX' },
  { name: 'Bank Dhofar', swift: 'BDOFOMRU' },
  { name: 'Sohar International Bank', swift: 'BSHROMRU' },
  { name: 'Oman Arab Bank', swift: 'OMABOMRU' },
  { name: 'Ahli Bank', swift: 'AUBOMRUX' },
  { name: 'Bank Nizwa', swift: 'BNIZOMRU' },
  { name: 'Alizz Islamic Bank', swift: 'AIBAOMRU' },
  { name: 'HSBC Bank Oman', swift: 'BBMEOMRX' },
];

async function main() {
  console.log('🌱 Seeding Oman Bank Master…');
  let created = 0;
  for (const b of OMAN_BANKS) {
    const existing = await prisma.bank.findFirst({
      where: { country: 'OM', name: b.name },
    });
    if (existing) continue;
    await prisma.bank.create({
      data: { country: 'OM', name: b.name, swift: b.swift ?? null, bankCode: null },
    });
    created += 1;
  }
  console.log(
    `✅ Oman banks: ${created} created, ${OMAN_BANKS.length - created} already present.`,
  );
  console.log(
    'ℹ️  Set each bank\'s 3-char CBO bankCode via Bank Master to enable IBAN bank-code validation.',
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

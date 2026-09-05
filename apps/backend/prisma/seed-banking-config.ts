/**
 * Idempotent seed for the Country Banking Configuration (default field schemas
 * for the shipped countries: OM, AE, IN, GB, US). Reuses the single source of
 * truth exported from the service so seed + runtime never drift.
 *
 * Run (from apps/backend), pointing at the target database:
 *   DATABASE_URL="postgresql://…/myappdb?schema=public" ts-node --transpile-only prisma/seed-banking-config.ts
 */
import { PrismaClient } from '@prisma/client';
import { DEFAULT_COUNTRY_FIELDS } from '../src/bank-details/banking-config.service';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding Country Banking Configuration…');
  let created = 0;
  for (const [country, fields] of Object.entries(DEFAULT_COUNTRY_FIELDS)) {
    for (const f of fields) {
      const exists = await prisma.countryBankingField.findUnique({
        where: { country_fieldKey: { country, fieldKey: f.fieldKey } },
      });
      if (exists) continue;
      await prisma.countryBankingField.create({ data: { country, ...f } as any });
      created += 1;
    }
  }
  console.log(`✅ Banking config: ${created} field(s) created.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

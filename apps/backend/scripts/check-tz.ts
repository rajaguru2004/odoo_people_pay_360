import { PrismaClient } from '@prisma/client';
import { DateTime } from 'luxon';

const prisma = new PrismaClient();

async function main() {
  const setting = await prisma.systemSetting.findUnique({
    where: { key: 'system_timezone' },
  });
  console.log('system_timezone setting:', setting);

  const tz = setting?.value || 'Asia/Kolkata';
  console.log('timezone in use:', tz);

  const referenceDate = new Date();
  console.log('Server time now:', referenceDate.toISOString());
  console.log('Local time in system_timezone:', DateTime.now().setZone(tz).toString());
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());

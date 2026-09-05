import { PrismaClient } from '@prisma/client';
import { DateTime } from 'luxon';

const prisma = new PrismaClient();

async function main() {
  const dateStr = '2026-07-02';
  const parts = dateStr.split('-');
  const dateKey = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 0, 0, 0, 0));

  console.log('Date Key UTC:', dateKey.toISOString());

  const attendances = await prisma.attendance.findMany({
    where: {
      date: dateKey,
      status: 'PRESENT',
    },
    include: {
      employee: true,
    },
  });

  console.log(`Found ${attendances.length} present attendances for ${dateStr}:`);
  for (const a of attendances) {
    console.log({
      employee: a.employee.fullName,
      checkIn: a.checkIn ? a.checkIn.toISOString() : null,
      localHourKolkata: a.checkIn ? DateTime.fromJSDate(a.checkIn).setZone('Asia/Kolkata').hour : null,
      localHourUTC: a.checkIn ? DateTime.fromJSDate(a.checkIn).setZone('utc').hour : null,
      isLate: a.isLate,
    });
  }
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());

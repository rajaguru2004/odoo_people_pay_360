import { PrismaClient } from '@prisma/client';
import { DateTime } from 'luxon';

const prisma = new PrismaClient();

function localHour(utcDate: Date, tz: string): number {
  return DateTime.fromJSDate(utcDate, { zone: 'utc' }).setZone(tz).hour;
}

async function main() {
  const companyTZ = 'Asia/Kolkata';
  const dateStr = '2026-07-02';
  const parts = dateStr.split('-');
  const referenceDate = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 0, 0, 0, 0));
  const today = referenceDate;

  console.log('Today date key:', today.toISOString());

  const todayAttendancesWhere: any = {
    date: today,
    checkIn: { not: null },
  };

  const todayAttendances = await prisma.attendance.findMany({
    where: todayAttendancesWhere,
    select: { checkIn: true, isLate: true, employee: { select: { fullName: true } } },
  });

  console.log('Fetched attendances count:', todayAttendances.length);

  const hours: Record<string, { present: number; late: number }> = {};
  for (let h = 7; h <= 18; h++) {
    hours[`${h}:00`] = { present: 0, late: 0 };
  }

  todayAttendances.forEach((a) => {
    if (a.checkIn) {
      const h = localHour(a.checkIn, companyTZ);
      const key = `${h}:00`;
      console.log(`Employee: ${a.employee.fullName}, checkIn: ${a.checkIn.toISOString()}, localHour: ${h}`);
      if (hours[key]) {
        hours[key].present++;
        if (a.isLate) hours[key].late++;
      }
    }
  });

  console.log('Hours map:', hours);
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const TZ_OFFSET_MINUTES = 5 * 60 + 30; // IST: UTC+5:30
const LATE_THRESHOLD = 15; // 15 minutes grace period

function getLocalHour(date: Date): number {
  const utcMs = date.getTime();
  const localMs = utcMs + TZ_OFFSET_MINUTES * 60 * 1000;
  return new Date(localMs).getUTCHours();
}

function getLocalMinutesOfDay(date: Date): number {
  const utcMs = date.getTime();
  const localMs = utcMs + TZ_OFFSET_MINUTES * 60 * 1000;
  const localDate = new Date(localMs);
  return localDate.getUTCHours() * 60 + localDate.getUTCMinutes();
}

async function main() {
  console.log('Starting recalculation of all attendance records...');

  // Fetch settings dynamically
  const startSetting = await prisma.systemSetting.findUnique({
    where: { key: 'office_start_time' },
  });
  const endSetting = await prisma.systemSetting.findUnique({
    where: { key: 'office_end_time' },
  });

  const startStr = startSetting?.value || '08:30';
  const endStr = endSetting?.value || '17:30';

  const [startHour, startMin] = startStr.split(':').map(Number);
  const [endHour, endMin] = endStr.split(':').map(Number);

  const workStart =
    (isNaN(startHour) ? 8 : startHour) * 60 + (isNaN(startMin) ? 30 : startMin);
  const workEnd =
    (isNaN(endHour) ? 17 : endHour) * 60 + (isNaN(endMin) ? 30 : endMin);

  const attendances = await prisma.attendance.findMany({
    where: {
      status: 'PRESENT',
    },
  });

  console.log(
    `Found ${attendances.length} PRESENT attendance records to process.`,
  );

  let updatedCount = 0;

  for (const attendance of attendances) {
    const { employeeId, date, checkIn, checkOut } = attendance;

    // Build a stable date key at UTC midnight (matching toDateKey in attendances.service.ts)
    const dateKey = new Date(
      Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0),
    );

    // Fetch schedule
    const schedule = await prisma.workSchedule.findFirst({
      where: {
        employeeId,
        date: dateKey,
        isWorkDay: true,
      },
    });

    let isLate = false;
    let isEarlyCheckIn = false;
    if (checkIn) {
      const checkInTime = new Date(checkIn);
      if (schedule && schedule.startTime) {
        const checkInTimeMs = checkInTime.getTime();
        const startTimeMs = new Date(schedule.startTime).getTime();
        isEarlyCheckIn = checkInTimeMs < startTimeMs;
        isLate = checkInTimeMs > startTimeMs + LATE_THRESHOLD * 60 * 1000;
      } else {
        isLate =
          getLocalMinutesOfDay(checkInTime) > workStart + LATE_THRESHOLD &&
          getLocalHour(checkInTime) >= 6 &&
          getLocalHour(checkInTime) < 23;
        const localHour = getLocalHour(checkInTime);
        const totalMinutes = getLocalMinutesOfDay(checkInTime);
        if (localHour >= 6 && localHour < 23) {
          isEarlyCheckIn = totalMinutes < workStart;
        }
      }
    }

    let isEarlyLeave = false;
    let isLateCheckout = false;
    if (checkIn && checkOut) {
      const checkInTime = new Date(checkIn);
      const checkOutTime = new Date(checkOut);
      if (schedule && schedule.endTime) {
        const checkOutTimeMs = checkOutTime.getTime();
        const endTimeMs = new Date(schedule.endTime).getTime();
        isEarlyLeave = checkOutTimeMs < endTimeMs;
        isLateCheckout = checkOutTimeMs > endTimeMs;
      } else {
        const currentMinutes = getLocalMinutesOfDay(checkOutTime);
        const localHour = getLocalHour(checkOutTime);
        if (localHour >= 6 && localHour < 23) {
          const durationHours =
            (checkOutTime.getTime() - checkInTime.getTime()) / (1000 * 60 * 60);
          if (durationHours < 4) {
            isEarlyLeave = true;
          } else {
            isEarlyLeave = currentMinutes < workEnd;
          }
          isLateCheckout = currentMinutes >= workEnd;
        }
      }
    }

    // Update in database
    await prisma.attendance.update({
      where: { id: attendance.id },
      data: {
        isLate,
        isEarlyLeave,
        isEarlyCheckIn,
        isLateCheckout,
      },
    });

    updatedCount++;
  }

  console.log(
    `Successfully recalculated and updated ${updatedCount} attendance records.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

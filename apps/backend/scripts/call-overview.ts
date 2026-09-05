import { PrismaClient } from '@prisma/client';
import { AttendancesService } from '../src/attendances/attendances.service';
import { TimezoneService } from '../src/common/timezone/timezone.service';
import { SystemSettingsService } from '../src/system-settings/system-settings.service';
import { HolidaysService } from '../src/holidays/holidays.service';

const prisma = new PrismaClient();
const settings = new SystemSettingsService(prisma as any, null as any);
const tzSvc = new TimezoneService(settings);
const holidays = new HolidaysService(prisma as any);
const attendanceService = new AttendancesService(
  prisma as any,
  settings,
  tzSvc,
  null as any,
  holidays,
);

async function main() {
  const dateStr = '2026-07-02';
  const overview = await attendanceService.getOverview('today', undefined, dateStr);
  console.log('Overview stats:', overview.data.stats);
  console.log('Overview trendData:', overview.data.trendData);
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());

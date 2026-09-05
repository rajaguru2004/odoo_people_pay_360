import { Module } from '@nestjs/common';
import { AttendancesService } from './attendances.service';
import { AttendancesController } from './attendances.controller';
import { AttendanceCalendarService } from './attendance-calendar.service';
import { AttendanceHubService } from './attendance-hub.service';

/**
 * The calendar service is exported because the corrections module re-derives a
 * row's status through it on approval — the rules that decide LATE have to be
 * the same rules whichever door the times came in by.
 */
@Module({
  controllers: [AttendancesController],
  providers: [
    AttendancesService,
    AttendanceCalendarService,
    AttendanceHubService,
  ],
  exports: [AttendancesService, AttendanceCalendarService],
})
export class AttendancesModule {}

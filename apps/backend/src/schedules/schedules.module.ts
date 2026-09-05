import { Module } from '@nestjs/common';
import { AttendancesModule } from '../attendances/attendances.module';
import { SchedulesController } from './schedules.controller';
import { SchedulesService } from './schedules.service';
import { SchedulesHubService } from './schedules-hub.service';

/**
 * Reading the roster: one employee's calendar, the company-wide grid, coverage,
 * conflicts and the module dashboard.
 *
 * `AttendancesModule` is imported for `AttendanceCalendarService`, which already
 * resolves a branch's working day — its zone, its office hours, its weekly offs
 * and the holidays it observes. Re-deriving that here would give the two modules
 * two different answers to "was the office open", and the schedules hub would
 * report a coverage hole on a day the attendance hub expected nobody.
 *
 * Writes stay in `WorkSchedulesModule`, which owns the rows.
 */
@Module({
  imports: [AttendancesModule],
  controllers: [SchedulesController],
  providers: [SchedulesService, SchedulesHubService],
  exports: [SchedulesService],
})
export class SchedulesModule {}

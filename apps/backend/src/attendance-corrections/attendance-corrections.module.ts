import { Module } from '@nestjs/common';
import { AttendanceCorrectionsService } from './attendance-corrections.service';
import { AttendanceCorrectionsController } from './attendance-corrections.controller';
import { AttendancesModule } from '../attendances/attendances.module';

/**
 * Imports AttendancesModule for the calendar service alone: approving a
 * correction has to re-derive the day's verdict with the same rules a punch
 * would, and a second copy of those rules here would drift from the first.
 */
@Module({
  imports: [AttendancesModule],
  controllers: [AttendanceCorrectionsController],
  providers: [AttendanceCorrectionsService],
  exports: [AttendanceCorrectionsService],
})
export class AttendanceCorrectionsModule {}

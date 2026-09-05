import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateWorkScheduleDto } from './create-work-schedule.dto';

/**
 * `employeeId` and `date` are not editable: moving a roster row to another
 * person or another day is a different row, and the unique constraint on the
 * pair is what would break first.
 */
export class UpdateWorkScheduleDto extends PartialType(
  OmitType(CreateWorkScheduleDto, ['employeeId', 'date'] as const),
) {}

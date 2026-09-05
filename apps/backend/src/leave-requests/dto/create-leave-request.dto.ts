import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { DAY_KEY_PATTERN } from '../../attendances/attendance-calendar.util';

export class CreateLeaveRequestDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Whose leave this is. Omit to file your own. Naming somebody else is an ' +
      'HR privilege — the days come out of THEIR balance.',
  })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiProperty({
    example: 'Annual Leave',
    description:
      'A LEAVE_TYPE library LABEL. Read the current list from GET /leave-balances/leave-types.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  leaveType: string;

  @ApiProperty({ example: '2026-01-20' })
  @Matches(DAY_KEY_PATTERN, { message: 'startDate must be YYYY-MM-DD' })
  startDate: string;

  @ApiProperty({ example: '2026-01-22' })
  @Matches(DAY_KEY_PATTERN, { message: 'endDate must be YYYY-MM-DD' })
  endDate: string;

  @ApiProperty({ example: 'Family visit' })
  @IsString()
  @MinLength(3, { message: 'Say why, in a sentence' })
  @MaxLength(1000)
  reason: string;
}

export class DecideLeaveRequestDto {
  @ApiPropertyOptional({
    example: 'Approved. Please hand over the Tuesday report.',
    description:
      'The approver note on an approval, the reason on a rejection. Required to reject.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment?: string;
}

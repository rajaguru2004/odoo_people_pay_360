import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class CreateLeaveRequestDto {
  @ApiPropertyOptional({
    description: 'Whose leave this is. HR may file for somebody else.',
  })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiProperty({
    example: 'Annual Leave',
    description:
      'A LEAVE_TYPE library label. The short codes (ANNUAL, SICK, …) also resolve.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  leaveType: string;

  @ApiProperty({ example: '2026-01-20', description: 'First day of leave' })
  @IsISO8601({ strict: true })
  startDate: string;

  @ApiProperty({ example: '2026-01-22', description: 'Last day of leave' })
  @IsISO8601({ strict: true })
  endDate: string;

  @ApiProperty({ example: 'Family visit' })
  @IsString()
  @IsNotEmpty()
  reason: string;
}

export class ApproveRejectLeaveDto {
  @ApiPropertyOptional({
    example: 'Ineligible for this period',
    description: 'Reason recorded on a rejection',
  })
  @IsOptional()
  @IsString()
  rejectedReason?: string;

  @ApiPropertyOptional({
    example: 'Approved. Please arrange the handover.',
    description: "The approver's note on the step",
  })
  @IsOptional()
  @IsString()
  comment?: string;
}

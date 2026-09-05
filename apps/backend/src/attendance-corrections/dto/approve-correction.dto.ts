import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class ApproveAttendanceCorrectionDto {
  @ApiProperty({
    example: 'Confirmed with direct manager',
    description: 'Approval notes',
    required: false,
  })
  @IsOptional()
  @IsString()
  notes?: string;
}

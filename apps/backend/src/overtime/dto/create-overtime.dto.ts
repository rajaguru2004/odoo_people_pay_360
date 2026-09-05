import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class CreateOvertimeDto {
  @ApiProperty({ example: '2026-01-15', description: 'Overtime date' })
  @IsDateString()
  @IsNotEmpty()
  date: string;

  @ApiProperty({
    example: '2026-01-15T17:30:00Z',
    description: 'Overtime start time',
  })
  @IsDateString()
  @IsNotEmpty()
  startTime: string;

  @ApiProperty({
    example: '2026-01-15T20:30:00Z',
    description: 'Overtime end time',
  })
  @IsDateString()
  @IsNotEmpty()
  endTime: string;

  @ApiProperty({
    example: 3,
    description: 'Number of overtime hours',
  })
  @IsNumber()
  @Min(0.5)
  hours: number;

  @ApiPropertyOptional({
    example: 'Completed urgent project',
    description:
      'Reason for overtime. Mandatory only while the overtime_require_reason setting is enabled — enforced in the service, not here.',
  })
  @IsOptional()
  @IsString()
  reason?: string;
}

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
  @ApiProperty({ example: '2026-01-15', description: 'The day worked' })
  @IsDateString()
  @IsNotEmpty()
  date: string;

  @ApiProperty({
    example: '2026-01-15T17:30:00Z',
    description: 'Start of the worked window, wall-clock tagged UTC',
  })
  @IsDateString()
  @IsNotEmpty()
  startTime: string;

  @ApiProperty({
    example: '2026-01-15T20:30:00Z',
    description:
      'End of the worked window. An end at or before the start is read as crossing midnight.',
  })
  @IsDateString()
  @IsNotEmpty()
  endTime: string;

  @ApiProperty({ example: 3, description: 'Hours worked' })
  @IsNumber()
  @Min(0.5)
  hours: number;

  @ApiPropertyOptional({
    example: 'Closed the month-end run',
    description:
      'Mandatory only while overtime_require_reason is on, which the service enforces rather than this DTO.',
  })
  @IsOptional()
  @IsString()
  reason?: string;
}

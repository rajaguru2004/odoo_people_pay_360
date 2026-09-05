import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateOvertimeDto {
  @ApiProperty({ example: '2026-01-15', description: 'The day worked' })
  @IsDateString()
  @IsNotEmpty()
  date: string;

  @ApiProperty({
    example: '2026-01-15T17:30:00Z',
    description:
      'Worked from. Wall clock tagged UTC — an entered 17:30 is sent as ' +
      '"…T17:30:00Z", so the server recovers the entered hour whatever zone it runs in.',
  })
  @IsDateString()
  @IsNotEmpty()
  startTime: string;

  @ApiProperty({
    example: '2026-01-15T20:30:00Z',
    description:
      'Worked until. An end at or before the start is read as crossing midnight, not as an error.',
  })
  @IsDateString()
  @IsNotEmpty()
  endTime: string;

  @ApiProperty({
    example: 3,
    description:
      'What the employee believes they worked. Checked against the window ' +
      'and refused when the two disagree by more than 0.1h — the server never ' +
      'silently takes the typed figure over the times it was given.',
  })
  @IsNumber()
  @Min(0.5)
  hours: number;

  @ApiPropertyOptional({
    example: 'Line 3 changeover ran long',
    description:
      'Mandatory only while overtime_require_reason is on — enforced in the service, not here.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

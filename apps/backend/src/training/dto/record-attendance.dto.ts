import {
  IsBoolean,
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RecordAttendanceDto {
  @ApiProperty({ description: 'false records a NO_SHOW' })
  @IsBoolean()
  attended: boolean;

  @ApiPropertyOptional({ description: 'Defaults to the session end date' })
  @IsOptional()
  @IsDateString()
  attendedAt?: string;

  @ApiPropertyOptional({ example: 87.5 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  score?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  passed?: boolean;

  @ApiPropertyOptional({
    description:
      'Certificate file URL. Its expiry is derived from the course validity window and this date.',
  })
  @IsOptional()
  @IsString()
  certificateUrl?: string;
}

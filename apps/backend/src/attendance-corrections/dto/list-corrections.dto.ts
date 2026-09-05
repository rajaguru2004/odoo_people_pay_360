import { IsEnum, IsOptional, IsUUID, Matches } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { RequestStatus } from '@prisma/client';
import { DAY_KEY_PATTERN } from '../../attendances/attendance-calendar.util';

export class ListCorrectionsDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  page?: number;

  @ApiPropertyOptional({ default: 20, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  limit?: number;

  @ApiPropertyOptional({ enum: RequestStatus })
  @IsOptional()
  @IsEnum(RequestStatus)
  status?: RequestStatus;

  @ApiPropertyOptional({
    description: 'Ignored for an EMPLOYEE caller, who only ever sees their own',
  })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional({ example: '2026-03-01' })
  @IsOptional()
  @Matches(DAY_KEY_PATTERN, { message: 'startDate must be YYYY-MM-DD' })
  startDate?: string;

  @ApiPropertyOptional({ example: '2026-03-31' })
  @IsOptional()
  @Matches(DAY_KEY_PATTERN, { message: 'endDate must be YYYY-MM-DD' })
  endDate?: string;
}

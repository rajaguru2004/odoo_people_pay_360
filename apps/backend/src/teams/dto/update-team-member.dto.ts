import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { TeamMemberRole } from '@prisma/client';

export class UpdateTeamMemberDto {
  @ApiPropertyOptional({ enum: TeamMemberRole })
  @IsOptional()
  @IsEnum(TeamMemberRole)
  role?: TeamMemberRole;

  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  allocation?: number;

  @ApiPropertyOptional({ example: '2026-06-30' })
  @IsOptional()
  @IsDateString()
  endDate?: string;
}

import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TeamMemberRole } from '@prisma/client';

export class AddTeamMemberDto {
  @ApiProperty()
  @IsUUID()
  employeeId: string;

  @ApiPropertyOptional({
    enum: TeamMemberRole,
    default: TeamMemberRole.MEMBER,
  })
  @IsOptional()
  @IsEnum(TeamMemberRole)
  role?: TeamMemberRole;

  @ApiPropertyOptional({
    default: 100,
    minimum: 0,
    maximum: 100,
    description: 'Percentage of the person committed to this team',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  allocation?: number;

  @ApiPropertyOptional({ example: '2026-02-01' })
  @IsOptional()
  @IsDateString()
  startDate?: string;
}

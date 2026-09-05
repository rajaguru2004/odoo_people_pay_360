import {
  IsUUID,
  IsEnum,
  IsInt,
  Min,
  Max,
  IsOptional,
  IsDateString,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum TeamMemberRole {
  LEAD = 'LEAD',
  SENIOR = 'SENIOR',
  MEMBER = 'MEMBER',
  CONTRIBUTOR = 'CONTRIBUTOR',
}

export class AddTeamMemberDto {
  @ApiProperty({ example: 'uuid', description: 'Employee ID' })
  @IsUUID()
  employeeId: string;

  @ApiPropertyOptional({ enum: TeamMemberRole, default: TeamMemberRole.MEMBER })
  @IsOptional()
  @IsEnum(TeamMemberRole)
  role?: TeamMemberRole;

  @ApiPropertyOptional({
    example: 100,
    description: 'Allocation percentage (0-100)',
    default: 100,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  allocationPercentage?: number;

  @ApiPropertyOptional({ example: '2026-01-01', description: 'Start date' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({
    example: '2026-12-31',
    description: 'End date (for temporary assignments)',
  })
  @IsOptional()
  @IsDateString()
  endDate?: string;
}

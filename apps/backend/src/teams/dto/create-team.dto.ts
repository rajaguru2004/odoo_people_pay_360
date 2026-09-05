import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TeamType } from '@prisma/client';

export class CreateTeamDto {
  @ApiProperty({ example: 'PAY-CORE' })
  @IsString()
  @MaxLength(32)
  code: string;

  @ApiProperty({ example: 'Payroll Core' })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ description: 'Department the team belongs to' })
  @IsUUID()
  departmentId: string;

  @ApiPropertyOptional({ description: 'Employee who leads the team' })
  @IsOptional()
  @IsUUID()
  teamLeadId?: string;

  @ApiPropertyOptional({ enum: TeamType, default: TeamType.PERMANENT })
  @IsOptional()
  @IsEnum(TeamType)
  type?: TeamType;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

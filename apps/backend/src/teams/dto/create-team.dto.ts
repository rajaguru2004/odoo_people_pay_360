import {
  IsString,
  IsOptional,
  IsUUID,
  IsEnum,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum TeamType {
  PERMANENT = 'PERMANENT',
  PROJECT = 'PROJECT',
  CROSS_FUNCTIONAL = 'CROSS_FUNCTIONAL',
}

export class CreateTeamDto {
  @ApiProperty({ example: 'Backend Team', description: 'Team name' })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiProperty({ example: 'BE-TEAM', description: 'Unique team code' })
  @IsString()
  @MaxLength(50)
  code: string;

  @ApiPropertyOptional({
    example: 'Backend development team',
    description: 'Team description',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    example: 'uuid',
    description: 'Department ID that owns this team',
  })
  @IsUUID()
  departmentId: string;

  @ApiPropertyOptional({
    example: 'uuid',
    description: 'Team lead employee ID',
  })
  @IsOptional()
  @IsUUID()
  teamLeadId?: string;

  @ApiPropertyOptional({ enum: TeamType, default: TeamType.PERMANENT })
  @IsOptional()
  @IsEnum(TeamType)
  type?: TeamType;
}

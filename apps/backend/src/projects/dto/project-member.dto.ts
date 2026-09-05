import { IsUUID, IsEnum, IsOptional, IsArray, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

const MEMBER_ROLES = ['OWNER', 'MANAGER', 'MEMBER', 'VIEWER'];

export class AddProjectMemberDto {
  @ApiProperty({ example: 'employee-uuid' })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiProperty({ example: ['employee-uuid-1'], required: false })
  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  employeeIds?: string[];

  @ApiProperty({ description: 'ProjectRole id to assign', required: false })
  @IsOptional()
  @IsUUID()
  roleId?: string;

  @ApiProperty({
    enum: MEMBER_ROLES,
    description: 'Legacy role slug/name (used if roleId omitted)',
    required: false,
  })
  @IsOptional()
  @IsString()
  role?: string;
}

export class UpdateProjectMemberDto {
  @ApiProperty({ description: 'ProjectRole id to assign', required: false })
  @IsOptional()
  @IsUUID()
  roleId?: string;

  @ApiProperty({ enum: MEMBER_ROLES, required: false })
  @IsOptional()
  @IsString()
  role?: string;
}

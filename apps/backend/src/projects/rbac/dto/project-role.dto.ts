import {
  IsString,
  IsOptional,
  IsArray,
  IsUUID,
  MaxLength,
  ArrayUnique,
  IsIn,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { ALL_PROJECT_PERMISSIONS } from '../permissions.constants';

export class CreateProjectRoleDto {
  @ApiProperty({ example: 'QA Reviewer' })
  @IsString()
  @MaxLength(50)
  name: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ required: false, example: '#0EA5E9' })
  @IsOptional()
  @IsString()
  @MaxLength(9)
  color?: string;

  @ApiProperty({ required: false, isArray: true, enum: ALL_PROJECT_PERMISSIONS })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(ALL_PROJECT_PERMISSIONS as unknown as string[], { each: true })
  permissions?: string[];

  @ApiProperty({ required: false, description: 'Copy permissions from this role' })
  @IsOptional()
  @IsUUID()
  copyFromRoleId?: string;
}

export class UpdateProjectRoleDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ required: false, example: '#0EA5E9' })
  @IsOptional()
  @IsString()
  @MaxLength(9)
  color?: string;

  @ApiProperty({ required: false, isArray: true, enum: ALL_PROJECT_PERMISSIONS })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(ALL_PROJECT_PERMISSIONS as unknown as string[], { each: true })
  permissions?: string[];
}

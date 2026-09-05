import {
  IsString,
  IsOptional,
  IsEnum,
  IsUUID,
  IsDateString,
  IsArray,
  MaxLength,
  Matches,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

const PROJECT_STATUS = ['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED'];
const PROJECT_PRIORITY = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
const PROJECT_VISIBILITY = ['PRIVATE', 'INTERNAL', 'PUBLIC'];

export class CreateProjectDto {
  @ApiProperty({ example: 'Website Redesign', description: 'Project name' })
  @IsString()
  @MaxLength(150)
  name: string;

  @ApiProperty({ example: 'website-redesign', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  @Matches(/^[a-z0-9-]+$/, {
    message: 'slug must be lowercase alphanumeric with hyphens',
  })
  slug?: string;

  @ApiProperty({ example: 'WEB', required: false, description: 'Task code prefix' })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  taskPrefix?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  // R49: `color` was length-checked only, so 'not-a-hex' was stored and served
  // to the UI as a CSS value. The column is VarChar(9), which is exactly
  // `#RRGGBB` or `#RRGGBBAA`.
  @ApiProperty({ example: '#00358F', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(9)
  @Matches(/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, {
    message: 'color must be a hex value like #RRGGBB or #RRGGBBAA',
  })
  color?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  avatar?: string;

  @ApiProperty({ enum: PROJECT_STATUS, default: 'PLANNING', required: false })
  @IsOptional()
  @IsEnum(PROJECT_STATUS)
  status?: string;

  @ApiProperty({ enum: PROJECT_PRIORITY, default: 'MEDIUM', required: false })
  @IsOptional()
  @IsEnum(PROJECT_PRIORITY)
  priority?: string;

  @ApiProperty({ enum: PROJECT_VISIBILITY, default: 'PRIVATE', required: false })
  @IsOptional()
  @IsEnum(PROJECT_VISIBILITY)
  visibility?: string;

  @ApiProperty({ example: '2026-07-01', required: false })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiProperty({ example: '2026-12-31', required: false })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiProperty({ required: false, description: 'Workflow UUID (defaults to default workflow)' })
  @IsOptional()
  @IsUUID()
  workflowId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  teamId?: string;

  @ApiProperty({ required: false, description: 'Owner employee UUID' })
  @IsOptional()
  @IsUUID()
  ownerId?: string;

  @ApiProperty({ required: false, description: 'Initial member employee UUIDs' })
  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  memberIds?: string[];
}

import {
  IsOptional,
  IsEnum,
  IsUUID,
  IsString,
  IsDateString,
  IsNumber,
  Min,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class QueryTaskDto {
  @ApiProperty({
    required: false,
    enum: [
      'TODO',
      'IN_PROGRESS',
      'IN_REVIEW',
      'COMPLETED',
      'CANCELLED',
      'BLOCKED',
    ],
  })
  @IsOptional()
  @IsEnum([
    'TODO',
    'IN_PROGRESS',
    'IN_REVIEW',
    'COMPLETED',
    'CANCELLED',
    'BLOCKED',
  ])
  status?: string;

  @ApiProperty({ required: false, enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] })
  @IsOptional()
  @IsEnum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
  priority?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  assigneeId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  reporterId?: string;

  @ApiProperty({ required: false, description: 'Filter by project UUID' })
  @IsOptional()
  @IsUUID()
  projectId?: string;

  @ApiProperty({ required: false, description: 'Filter by workflow status UUID' })
  @IsOptional()
  @IsUUID()
  statusId?: string;

  @ApiProperty({ required: false, description: 'Comma-separated workflow status UUIDs' })
  @IsOptional()
  @IsString()
  statuses?: string;

  @ApiProperty({ required: false, description: 'Comma-separated task types' })
  @IsOptional()
  @IsString()
  types?: string;

  @ApiProperty({ required: false, description: 'Comma-separated label UUIDs' })
  @IsOptional()
  @IsString()
  labels?: string;

  @ApiProperty({ required: false, description: 'Filter by sprint UUID' })
  @IsOptional()
  @IsUUID()
  sprintId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  startDateFrom?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  startDateTo?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  dueDateFrom?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  dueDateTo?: string;

  @ApiProperty({ required: false, description: 'Search by title or taskCode' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiProperty({ required: false, default: false })
  @IsOptional()
  isArchived?: boolean;

  @ApiProperty({ required: false, default: 1 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @ApiProperty({ required: false, default: 20 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  limit?: number;

  @ApiProperty({ required: false, default: 'createdAt' })
  @IsOptional()
  @IsString()
  sortBy?: string;

  @ApiProperty({ required: false, default: 'desc', enum: ['asc', 'desc'] })
  @IsOptional()
  @IsEnum(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';
}

export class AssignTaskDto {
  @ApiProperty({ example: 'uuid-of-employee' })
  @IsUUID()
  assigneeId: string;
}

export class ChangeStatusDto {
  @ApiProperty({
    enum: [
      'TODO',
      'IN_PROGRESS',
      'IN_REVIEW',
      'COMPLETED',
      'CANCELLED',
      'BLOCKED',
    ],
  })
  @IsEnum([
    'TODO',
    'IN_PROGRESS',
    'IN_REVIEW',
    'COMPLETED',
    'CANCELLED',
    'BLOCKED',
  ])
  status: string;
}

export class BulkAssignDto {
  @ApiProperty({ example: ['task-uuid-1', 'task-uuid-2'] })
  @IsUUID('all', { each: true })
  taskIds: string[];

  @ApiProperty({ example: 'employee-uuid' })
  @IsUUID()
  assigneeId: string;
}

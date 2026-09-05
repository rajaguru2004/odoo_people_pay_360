import {
  IsString,
  IsOptional,
  IsEnum,
  IsUUID,
  IsDateString,
  IsNumber,
  IsArray,
  MaxLength,
  Min,
  IsBoolean,
  Max,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class CreateTaskDto {
  @ApiProperty({ example: 'Fix login bug', description: 'Task title' })
  @IsString()
  @MaxLength(500)
  title: string;

  @ApiProperty({
    example: 'Reproduce and fix the login redirect issue',
    required: false,
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    example: 'MEDIUM',
    enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
    default: 'MEDIUM',
  })
  @IsOptional()
  @IsEnum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
  priority?: string;

  @ApiProperty({
    example: 'TODO',
    enum: [
      'TODO',
      'IN_PROGRESS',
      'IN_REVIEW',
      'COMPLETED',
      'CANCELLED',
      'BLOCKED',
    ],
    default: 'TODO',
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

  @ApiProperty({ example: 'uuid-of-assignee', required: false })
  @IsOptional()
  @IsUUID()
  assigneeId?: string;

  @ApiProperty({ example: ['uuid-of-assignee-1'], required: false })
  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  assigneeIds?: string[];

  @ApiProperty({ example: 'uuid-of-reporter', required: false })
  @IsOptional()
  @IsUUID()
  reporterId?: string;

  @ApiProperty({ example: '2026-07-01', required: false })
  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @ApiProperty({ example: '2026-06-20', required: false })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiProperty({
    example: 8.5,
    description: 'Estimated hours',
    required: false,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  estimatedHours?: number;

  @ApiProperty({ example: ['bug', 'frontend'], required: false })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiProperty({ example: false, description: 'Is private task', required: false })
  @IsOptional()
  @IsBoolean()
  isPrivate?: boolean;

  // ─── Project Management fields ──────────────────────────────────────────────

  @ApiProperty({ required: false, description: 'Project UUID (project task)' })
  @IsOptional()
  @IsUUID()
  projectId?: string;

  @ApiProperty({ required: false, description: 'Workflow status UUID (required for project tasks)' })
  @IsOptional()
  @IsUUID()
  statusId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  sprintId?: string;

  @ApiProperty({ required: false, description: 'Parent task UUID (subtask)' })
  @IsOptional()
  @IsUUID()
  parentTaskId?: string;

  @ApiProperty({ enum: ['TASK', 'BUG', 'EPIC', 'STORY', 'SUBTASK'], default: 'TASK', required: false })
  @IsOptional()
  @IsEnum(['TASK', 'BUG', 'EPIC', 'STORY', 'SUBTASK'])
  type?: string;

  // `Task.storyPoints` is a Postgres `int4`. Without the upper bound anything
  // past 2^31-1 passed validation and failed inside Prisma, so a plain
  // out-of-range input reached the caller as a bare 500 (finding R61).
  @ApiProperty({ required: false, example: 5, maximum: 2147483647 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(2147483647)
  @Type(() => Number)
  storyPoints?: number;

  @ApiProperty({ required: false, description: 'Label UUIDs to attach' })
  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  labelIds?: string[];

  // ─── Geo location (optional) ────────────────────────────────────────────────

  @ApiProperty({ example: 'Main Office, Chennai', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  locationName?: string;

  @ApiProperty({ example: 13.0827, required: false })
  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  @Type(() => Number)
  latitude?: number;

  @ApiProperty({ example: 80.2707, required: false })
  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  @Type(() => Number)
  longitude?: number;
}

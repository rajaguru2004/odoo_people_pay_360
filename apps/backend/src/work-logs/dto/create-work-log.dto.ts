import {
  IsUUID,
  IsOptional,
  IsString,
  IsDateString,
  IsNumber,
  Min,
  MaxLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class CreateWorkLogDto {
  @ApiProperty({ example: 'uuid-of-task' })
  @IsUUID()
  taskId: string;

  @ApiProperty({
    example: '2026-06-12T09:00:00.000Z',
    description: 'Start time (ISO)',
  })
  @IsDateString()
  startTime: string;

  @ApiProperty({
    example: '2026-06-12T11:30:00.000Z',
    description: 'End time (ISO)',
  })
  @IsDateString()
  endTime: string;

  @ApiProperty({ example: 'Implemented task API', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class UpdateWorkLogDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  startTime?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  endTime?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class StartTimerDto {
  @ApiProperty({ example: 'uuid-of-task' })
  @IsUUID()
  taskId: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class StopTimerDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

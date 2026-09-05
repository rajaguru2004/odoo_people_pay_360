import {
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  Max,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class CreateTimesheetDto {
  @ApiProperty({ example: '2026-06-12', description: 'Work date' })
  @IsDateString()
  workDate: string;

  @ApiProperty({ example: 7.5, description: 'Hours worked (0.5 - 24)' })
  @IsNumber()
  @Min(0.5)
  @Max(24)
  @Type(() => Number)
  hoursWorked: number;

  @ApiProperty({ example: 'Worked on API integration', required: false })
  @IsOptional()
  @IsString()
  description?: string;
}

export class UpdateTimesheetDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  workDate?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(0.5)
  @Max(24)
  @Type(() => Number)
  hoursWorked?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;
}

export class ApproveRejectTimesheetDto {
  @ApiProperty({ example: 'Approved, good work.', required: false })
  @IsOptional()
  @IsString()
  comment?: string;

  @ApiProperty({ example: 'Hours do not match logged work', required: false })
  @IsOptional()
  @IsString()
  rejectionReason?: string;
}

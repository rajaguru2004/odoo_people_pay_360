import {
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ContractStatus, ContractType, WorkType } from '@prisma/client';

export class CreateContractDto {
  @ApiProperty()
  @IsUUID()
  employeeId: string;

  @ApiPropertyOptional({
    example: 'CTR-2026-0001',
    description: 'Generated as CTR-<year>-<sequence> when left out',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  contractNumber?: string;

  @ApiProperty({ enum: ContractType })
  @IsEnum(ContractType)
  contractType: ContractType;

  @ApiPropertyOptional({ enum: WorkType, default: WorkType.FULL_TIME })
  @IsOptional()
  @IsEnum(WorkType)
  workType?: WorkType;

  @ApiPropertyOptional({ enum: ContractStatus, default: ContractStatus.DRAFT })
  @IsOptional()
  @IsEnum(ContractStatus)
  status?: ContractStatus;

  @ApiProperty({ example: '2026-01-01' })
  @IsDateString()
  startDate: string;

  @ApiPropertyOptional({
    example: '2027-12-31',
    description: 'Leave out for a permanent contract',
  })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ example: '2026-04-01' })
  @IsOptional()
  @IsDateString()
  probationEndDate?: string;

  @ApiPropertyOptional({ default: 40 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(168)
  workHoursPerWeek?: number;

  @ApiProperty({ example: 1250.5, description: 'Three decimal places' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  salary: number;

  @ApiPropertyOptional({ example: 'OMR', default: 'OMR' })
  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  @ApiPropertyOptional({ default: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  noticePeriodDays?: number;

  @ApiPropertyOptional({ default: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  annualLeaveDays?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  terms?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(512)
  documentUrl?: string;
}

import {
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ContractType, WorkType } from '@prisma/client';

/**
 * The successor's terms. Anything left out is carried over from the contract
 * being renewed — a renewal that only moves the end date should not have to
 * restate the salary and risk retyping it wrong.
 */
export class RenewContractDto {
  @ApiProperty({ example: '2028-01-01' })
  @IsDateString()
  startDate: string;

  @ApiPropertyOptional({ example: '2029-12-31' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ example: '2028-04-01' })
  @IsOptional()
  @IsDateString()
  probationEndDate?: string;

  @ApiPropertyOptional({ enum: ContractType })
  @IsOptional()
  @IsEnum(ContractType)
  contractType?: ContractType;

  @ApiPropertyOptional({ enum: WorkType })
  @IsOptional()
  @IsEnum(WorkType)
  workType?: WorkType;

  @ApiPropertyOptional({ example: 1400 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  salary?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(168)
  workHoursPerWeek?: number;

  @ApiPropertyOptional({
    description: 'Generated as CTR-<year>-<sequence> when left out',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  contractNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

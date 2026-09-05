import {
  IsString,
  IsDateString,
  IsOptional,
  IsNumber,
  Min,
  IsEnum,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ContractType, WorkType, ContractStatus } from '../contract.constants';

export class UpdateContractDto {
  @ApiProperty({
    example: 'FIXED_TERM',
    enum: ContractType,
    required: false,
  })
  @IsOptional()
  @IsEnum(ContractType)
  contractType?: string;

  @ApiProperty({ example: '2025-12-31', required: false })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiProperty({ example: 18000000, required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  salary?: number;

  @ApiProperty({
    example: 'FULL_TIME',
    enum: WorkType,
    required: false,
  })
  @IsOptional()
  @IsEnum(WorkType)
  workType?: string;

  @ApiProperty({ example: 40, required: false })
  @IsOptional()
  @IsNumber()
  @Min(1)
  workHoursPerWeek?: number;

  @ApiProperty({ example: 'Updated terms...', required: false })
  @IsOptional()
  @IsString()
  terms?: string;

  @ApiProperty({ example: 'Updated notes', required: false })
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiProperty({
    example: 'ACTIVE',
    enum: ContractStatus,
    required: false,
  })
  @IsOptional()
  @IsEnum(ContractStatus)
  status?: string;
}

export class RenewContractDto {
  @ApiProperty({ example: '2026-01-01', description: 'New end date' })
  @IsDateString()
  newEndDate: string;

  @ApiProperty({
    example: 20000000,
    required: false,
    description: 'New salary',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  newSalary?: number;

  @ApiProperty({
    example: 'FIXED_TERM',
    enum: ContractType,
    required: false,
  })
  @IsOptional()
  @IsEnum(ContractType)
  newContractType?: string;
}

export class TerminateContractDto {
  @ApiProperty({
    example: 'Personal reasons',
    description: 'Termination reason',
  })
  @IsString()
  reason: string;

  /**
   * Proceed even though the employee still holds company assets. ADMIN/
   * HR_MANAGER only; always audited as CLEARANCE_OVERRIDDEN.
   */
  @ApiPropertyOptional({ description: 'Override the asset clearance check' })
  @IsOptional()
  @IsString()
  clearanceOverrideReason?: string;
}

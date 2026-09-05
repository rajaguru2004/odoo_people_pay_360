import {
  IsString,
  IsDateString,
  IsOptional,
  IsUUID,
  IsNumber,
  Min,
  IsEnum,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { ContractType, WorkType } from '../contract.constants';

export class CreateContractDto {
  @ApiProperty({
    example: '11111111-1111-1111-1111-111111111111',
    description: 'Employee ID',
  })
  @IsUUID()
  employeeId: string;

  @ApiProperty({
    example: 'FIXED_TERM',
    enum: ContractType,
    description:
      'Contract duration type: PROBATION (max 60 days), FIXED_TERM (12-36 months), INDEFINITE (no end date)',
  })
  @IsEnum(ContractType)
  contractType: string;

  @ApiProperty({
    example: 'HD-2024-001',
    required: false,
    description: 'Contract number',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  contractNumber?: string;

  @ApiProperty({
    example: '2024-01-01',
    description: 'Contract start date',
  })
  @IsDateString()
  startDate: string;

  @ApiProperty({
    example: '2025-01-01',
    required: false,
    description:
      'Contract end date (required for PROBATION and FIXED_TERM, must be null for INDEFINITE)',
  })
  @ValidateIf((o) => o.contractType !== 'INDEFINITE')
  @IsDateString()
  endDate?: string;

  @ApiProperty({
    example: 15000000,
    description: 'Base salary in VND',
  })
  @IsNumber()
  @Min(0)
  salary: number;

  @ApiProperty({
    example: 'FULL_TIME',
    enum: WorkType,
    required: false,
    description: 'Work mode',
  })
  @IsOptional()
  @IsEnum(WorkType)
  workType?: string;

  @ApiProperty({
    example: 40,
    required: false,
    description: 'Work hours per week',
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  workHoursPerWeek?: number;

  @ApiProperty({
    example: 'Contract terms...',
    required: false,
    description: 'Contract terms',
  })
  @IsOptional()
  @IsString()
  terms?: string;

  @ApiProperty({
    example: 'Internal notes',
    required: false,
    description: 'Internal notes',
  })
  @IsOptional()
  @IsString()
  notes?: string;
}

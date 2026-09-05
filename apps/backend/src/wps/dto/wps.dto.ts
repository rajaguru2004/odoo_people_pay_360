import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  ValidateNested,
} from 'class-validator';

const BANK_OUTCOMES = ['ACKNOWLEDGED', 'PARTIALLY_REJECTED', 'REJECTED'] as const;

export class UpsertEmployerProfileDto {
  @ApiProperty({ description: 'Operator-facing label, e.g. "Muscat HQ establishment"' })
  @IsString()
  @Length(1, 255)
  name!: string;

  @ApiProperty({ description: 'Legal entity name as registered' })
  @IsString()
  @Length(1, 255)
  legalName!: string;

  @ApiProperty({ description: 'ISO-3166 alpha-2', example: 'OM' })
  @IsString()
  @Length(2, 2)
  country!: string;

  @ApiProperty({ description: 'WPS format registry key', example: 'om-cbo-v1' })
  @IsString()
  @MaxLength(50)
  format!: string;

  @ApiPropertyOptional({
    description:
      'Employer fields keyed by the format\'s employerConfigSchema[].name. Validated ' +
      'server-side against that schema; unknown keys are dropped. Omit a secret field ' +
      'to keep its stored value, send "" to clear it.',
  })
  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;
}

export class UpdateEmployerProfileDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 255)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 255)
  legalName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;
}

export class UpsertWpsConfigDto {
  @ApiProperty()
  @IsUUID()
  branchId!: string;

  @ApiProperty()
  @IsUUID()
  employerProfileId!: string;

  @ApiProperty({ example: 'om-cbo-v1' })
  @IsString()
  @MaxLength(50)
  format!: string;

  @ApiPropertyOptional({ description: 'Off by default — nothing generates until enabled.' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ description: 'Defaults for the format\'s runOptionsSchema.' })
  @IsOptional()
  @IsObject()
  defaultRunOptions?: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      'WARNING codes pre-accepted for this branch, so the operator is not re-asked ' +
      'every run. BLOCKING codes are never waivable.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(50)
  acceptedWarnings?: string[];
}

export class PreflightDto {
  @ApiProperty({ description: 'The locked payroll to check' })
  @IsUUID()
  payrollId!: string;

  @ApiPropertyOptional({ description: 'Overrides the branch default run options.' })
  @IsOptional()
  @IsObject()
  runOptions?: Record<string, unknown>;
}

export class GenerateWpsDto {
  @ApiProperty()
  @IsUUID()
  payrollId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  runOptions?: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      'WARNING codes from the pre-flight, echoed back to confirm they were read. ' +
      'Every unaccepted warning code must appear here or generation is refused.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(100)
  acknowledgeWarnings?: string[];
}

export class SubmitWpsDto {
  @ApiPropertyOptional({ description: 'ISO date-time; defaults to now.' })
  @IsOptional()
  @IsString()
  submittedAt?: string;

  @ApiPropertyOptional({ description: 'The bank portal\'s reference for the upload.' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;
}

export class RejectedRowDto {
  @ApiProperty()
  @IsUUID()
  employeeId!: string;

  @ApiPropertyOptional({ description: 'The bank\'s rejection code for this row.' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class BankResponseDto {
  @ApiProperty({ enum: BANK_OUTCOMES })
  @IsIn(BANK_OUTCOMES as unknown as string[])
  outcome!: (typeof BANK_OUTCOMES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @ApiPropertyOptional({
    type: [RejectedRowDto],
    description: 'Required for PARTIALLY_REJECTED; the rows the bank bounced.',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RejectedRowDto)
  @ArrayMaxSize(5000)
  rejectedRows?: RejectedRowDto[];
}

export class CancelWpsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  IsDateString,
  Matches,
  Min,
  IsString,
} from 'class-validator';

/**
 * The component types that predate admin-defined ones.
 *
 * NOT a closed set any more: an admin who adds "HRA" or "DA" to the
 * `SALARY_COMPONENT_TYPE` library must be able to store a component under that
 * name, and the old `@IsEnum` here is exactly why they could not — every
 * unrecognised label collapsed to `OTHER`, so a payslip could never show a real
 * breakup. These stay as documentation and as the values the seeded library
 * produces.
 *
 * Only two codes mean anything to the payroll engine (see
 * `payroll-earnings.util.ts`): `BASIC` is the basic part of the contracted rate,
 * `PAYROLL_CONFIG` is internal deduction-override bookkeeping and carries no
 * money. Every other code is summed as an allowance, whatever it is called.
 */
export enum ComponentType {
  BASIC = 'BASIC',
  ALLOWANCE = 'ALLOWANCE',
  LUNCH = 'LUNCH',
  TRANSPORT = 'TRANSPORT',
  PHONE = 'PHONE',
  HOUSING = 'HOUSING',
  POSITION = 'POSITION',
  BONUS = 'BONUS',
  OTHER = 'OTHER',
  /** Stores per-employee payroll deduction overrides as JSON in the note field */
  PAYROLL_CONFIG = 'PAYROLL_CONFIG',
}

/**
 * An uppercase slug, bounded by the `VarChar(50)` column. Constrained rather
 * than free text so the value stays a stable machine key that reports and the
 * WPS/payslip formatters can group on — a label change must not fork history.
 */
export const COMPONENT_TYPE_PATTERN = /^[A-Z][A-Z0-9_]{0,49}$/;

export class CreateSalaryComponentDto {
  @ApiProperty({
    description: 'Employee ID (UUID)',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsString()
  employeeId: string;

  @ApiProperty({
    description:
      'Salary component type code. Any uppercase slug (A-Z, 0-9, _) up to 50 characters — the seeded values are listed under ComponentType, but an admin-defined library item such as HRA or DA is equally valid.',
    example: 'HRA',
  })
  @IsString()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @Matches(COMPONENT_TYPE_PATTERN, {
    message:
      'componentType must be an uppercase code of up to 50 characters (letters, digits and underscores), e.g. BASIC or HRA',
  })
  componentType: string;

  @ApiProperty({ description: 'Amount', example: 1000000 })
  @IsNumber()
  @Min(0)
  amount: number;

  @ApiProperty({
    description: 'Effective date',
    example: '2026-01-01',
    required: false,
  })
  @IsOptional()
  @IsDateString()
  effectiveDate?: string;

  @ApiProperty({
    description: 'Notes',
    example: 'Lunch allowance',
    required: false,
  })
  @IsOptional()
  note?: string;
}

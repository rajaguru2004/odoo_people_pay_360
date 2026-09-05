import { ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

/**
 * A branch's own answer to the loan policy.
 *
 * Every field is nullable and every one means the same thing when null: **defer
 * to the level below** — the global `LoanPolicy` row, then the SystemSetting,
 * then the hard-coded default. That is why nothing here has a default value: a
 * default would silently replace a company-wide decision with a local one.
 *
 * `branchId` null IS the global row, and it is unique, so there is exactly one
 * per branch and exactly one global.
 */
export class UpsertLoanPolicyDto {
  @ApiPropertyOptional({
    description: 'The branch this policy governs. Omit for the company-wide row.',
  })
  @IsOptional()
  @IsUUID()
  branchId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  // ── Affordability ────────────────────────────────────────────────────────

  @ApiPropertyOptional({ description: 'Take-home floor, in currency' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9999999999.99)
  minNetPayAmount?: number | null;

  @ApiPropertyOptional({ description: 'Take-home floor, as a percentage of net' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  minNetPayPercent?: number | null;

  @ApiPropertyOptional({ description: 'Ceiling on total deductions, as a percentage of net' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  maxTotalDeductionPercentOfNet?: number | null;

  // ── Behaviour when pay cannot cover the instalment ────────────────────────

  @ApiPropertyOptional({ enum: ['PARTIAL', 'DEFER', 'SKIP'] })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsIn(['PARTIAL', 'DEFER', 'SKIP'])
  shortfallPolicy?: string | null;

  @ApiPropertyOptional({ enum: ['CARRY_FORWARD', 'EXTEND_TENURE'] })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsIn(['CARRY_FORWARD', 'EXTEND_TENURE'])
  deferralMode?: string | null;

  @ApiPropertyOptional({ enum: ['CONTINUE', 'PAUSE', 'EXTEND'] })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsIn(['CONTINUE', 'PAUSE', 'EXTEND'])
  unpaidLeavePolicy?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(0)
  @Max(60)
  gracePeriodCycles?: number | null;

  // ── Eligibility ──────────────────────────────────────────────────────────

  @ApiPropertyOptional({ description: 'How many live loans one employee may hold here' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(50)
  maxActivePerEmployee?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(0)
  @Max(600)
  minServiceMonths?: number | null;

  @ApiPropertyOptional({ description: '0 means no salary-multiple ceiling' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9999.99)
  maxAmountMultipleOfSalary?: number | null;

  @ApiPropertyOptional({ enum: ['NONE', 'FLAT', 'REDUCING_BALANCE'] })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsIn(['NONE', 'FLAT', 'REDUCING_BALANCE'])
  interestDefaultMethod?: string | null;

  @ApiPropertyOptional({ description: 'Rounding slack when deciding a loan is fully repaid' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  roundingTolerance?: number | null;

  // ── Authority ────────────────────────────────────────────────────────────
  //
  // Narrower than the company list, never wider: the service applies these on
  // top of the global check rather than instead of it.

  @ApiPropertyOptional({ description: 'CSV of roles, e.g. ADMIN or ADMIN,HR_MANAGER' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @Matches(/^[A-Z_]+(,[A-Z_]+)*$/, {
    message: 'writeOffRoles must be a comma-separated list of role names',
  })
  writeOffRoles?: string | null;

  @ApiPropertyOptional({ description: 'CSV of roles' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @Matches(/^[A-Z_]+(,[A-Z_]+)*$/, {
    message: 'waiverRoles must be a comma-separated list of role names',
  })
  waiverRoles?: string | null;
}

export class UpdateLoanPolicyDto extends PartialType(UpsertLoanPolicyDto) {}

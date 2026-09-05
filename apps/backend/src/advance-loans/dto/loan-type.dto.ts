import { ApiProperty, ApiPropertyOptional, PartialType, OmitType } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * The loan product catalogue — the terms a request inherits at creation and
 * snapshots at approval.
 *
 * Every field here already existed on `LoanType` and on `AdvanceLoanRequest`;
 * what did not exist was any way to set one. The bounds below deliberately
 * mirror the columns (`Decimal(6,3)` for a rate, `Decimal(5,2)` for a percent)
 * rather than being chosen fresh, because a value the DTO accepts and the
 * column then rounds is a product whose stored terms differ from the ones the
 * administrator agreed to.
 */
export class CreateLoanTypeDto {
  @ApiProperty({ example: 'VEHICLE', description: 'Stable code, unique across the catalogue' })
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]{1,39}$/, {
    message:
      'Code must be 2-40 characters of A-Z, 0-9 or _ and start with a letter — it is the stable key a loan keeps for its whole life',
  })
  code: string;

  @ApiProperty({ example: 'Vehicle Loan' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional({ enum: ['LOAN', 'ADVANCE'], default: 'LOAN' })
  @IsOptional()
  @IsIn(['LOAN', 'ADVANCE'])
  category?: 'LOAN' | 'ADVANCE';

  @ApiPropertyOptional({ description: 'null / omitted => offered in every branch' })
  @IsOptional()
  @IsUUID()
  branchId?: string | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(9999)
  sortOrder?: number;

  // ── Default terms ────────────────────────────────────────────────────────

  @ApiPropertyOptional({ enum: ['NONE', 'FLAT', 'REDUCING_BALANCE'], default: 'NONE' })
  @IsOptional()
  @IsIn(['NONE', 'FLAT', 'REDUCING_BALANCE'])
  interestMethod?: 'NONE' | 'FLAT' | 'REDUCING_BALANCE';

  /** 3dp so 8.375% is representable, matching `Decimal(6,3)`. */
  @ApiPropertyOptional({ example: 8.375 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Max(100)
  interestRate?: number;

  @ApiPropertyOptional({ enum: ['MONTHLY', 'WEEKLY', 'QUARTERLY'], default: 'MONTHLY' })
  @IsOptional()
  @IsIn(['MONTHLY', 'WEEKLY', 'QUARTERLY'])
  deductionFrequency?: 'MONTHLY' | 'WEEKLY' | 'QUARTERLY';

  @ApiPropertyOptional({ default: 12 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(600)
  defaultInstallments?: number;

  @ApiPropertyOptional({ default: 24 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(600)
  maxInstallments?: number;

  @ApiPropertyOptional({ description: 'Percent of principal charged as a processing fee' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Max(100)
  processingFeePercent?: number;

  @ApiPropertyOptional({ description: 'Flat processing fee, added to the percentage one' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9999999999.99)
  processingFeeFlat?: number;

  @ApiPropertyOptional({
    enum: ['DEDUCT_FROM_DISBURSEMENT', 'ADD_TO_FIRST_EMI', 'CAPITALIZE'],
    default: 'DEDUCT_FROM_DISBURSEMENT',
  })
  @IsOptional()
  @IsIn(['DEDUCT_FROM_DISBURSEMENT', 'ADD_TO_FIRST_EMI', 'CAPITALIZE'])
  processingFeeMode?: 'DEDUCT_FROM_DISBURSEMENT' | 'ADD_TO_FIRST_EMI' | 'CAPITALIZE';

  /** Share of INTEREST (never principal) borne by the employer. */
  @ApiPropertyOptional({ example: 50, description: '0-100, applied to interest only' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  employerSubsidyPercent?: number;

  @ApiPropertyOptional({ default: 0, description: 'Cycles before the first instalment falls due' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(60)
  gracePeriods?: number;

  @ApiPropertyOptional({
    enum: ['NONE', 'MORATORIUM_FULL', 'MORATORIUM_INTEREST_ONLY'],
    default: 'NONE',
  })
  @IsOptional()
  @IsIn(['NONE', 'MORATORIUM_FULL', 'MORATORIUM_INTEREST_ONLY'])
  graceMode?: 'NONE' | 'MORATORIUM_FULL' | 'MORATORIUM_INTEREST_ONLY';

  // ── Eligibility & affordability ──────────────────────────────────────────

  @ApiPropertyOptional({ description: 'Absolute ceiling on the principal' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9999999999.99)
  maxAmount?: number | null;

  @ApiPropertyOptional({ description: 'Ceiling expressed as a multiple of monthly salary' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9999.99)
  maxMultipleOfSalary?: number | null;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(600)
  minServiceMonths?: number;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  maxActiveLoans?: number;

  @ApiPropertyOptional({ description: 'Take-home floor once this product’s EMI is deducted' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9999999999.99)
  minNetSalaryAfterEmi?: number | null;

  @ApiPropertyOptional({ description: 'EMI ceiling as a percentage of net pay' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  maxEmiPercentOfNet?: number | null;

  @ApiPropertyOptional({ description: 'Smallest instalment worth scheduling' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9999999999.99)
  minEmiAmount?: number | null;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  requiresSecurity?: boolean;

  /** Employees have no `grade` column; grade/designation ceilings map to these. */
  @ApiPropertyOptional({ type: [String], description: 'Empty => every position is eligible' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  eligiblePositions?: string[];

  @ApiPropertyOptional({ type: [String], description: 'Empty => every employment type is eligible' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  eligibleEmploymentTypes?: string[];

  /** Recovery order when several loans compete for a limited net. Lower = first. */
  @ApiPropertyOptional({ default: 100, description: 'Lower recovers first' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  priority?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  pauseOnUnpaidLeave?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  allowPrepayment?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  allowWriteOff?: boolean;
}

/**
 * `code` is deliberately not updatable: it is the stable key a loan carries for
 * its whole life, and renaming it would silently re-point history. Change the
 * display `name` instead, or deactivate the product and create its successor.
 */
export class UpdateLoanTypeDto extends PartialType(
  OmitType(CreateLoanTypeDto, ['code'] as const),
) {}

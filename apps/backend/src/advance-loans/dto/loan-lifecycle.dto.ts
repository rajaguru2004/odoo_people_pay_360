import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Money fields carry an explicit upper bound as well as a lower one.
 *
 * `@IsPositive()` alone (what the original create DTO used) accepts 1e12 and
 * `Number.MAX_VALUE`, which is the doc's "extremely large loan values" case.
 * 2dp matches the Decimal(12,2) columns, so a 3dp payload is rejected at the
 * edge rather than silently rounded somewhere downstream.
 */
const MONEY = {
  maxDecimalPlaces: 2,
} as const;
const MAX_MONEY = 9999999999.99;

export class PrepayLoanDto {
  @ApiProperty({ example: 5000, description: 'Amount received, in major units' })
  @IsNumber(MONEY)
  @Min(0.01)
  @Max(MAX_MONEY)
  amount: number;

  @ApiProperty({ required: false, example: '2026-08-06' })
  @IsOptional()
  @IsDateString()
  paidOn?: string;

  @ApiProperty({ required: false, enum: ['CASH', 'BANK', 'CHEQUE', 'ADJUSTMENT'] })
  @IsOptional()
  @IsIn(['CASH', 'BANK', 'CHEQUE', 'ADJUSTMENT'])
  mode?: string;

  @ApiProperty({ required: false, description: 'Cheque number / UTR' })
  @IsOptional()
  @IsString()
  @Length(1, 120)
  reference?: string;

  @ApiProperty({
    required: false,
    enum: ['REDUCE_EMI', 'REDUCE_TENURE'],
    description:
      'REDUCE_TENURE keeps the instalment and shortens the loan; REDUCE_EMI ' +
      'keeps the number of instalments and lowers each one.',
  })
  @IsOptional()
  @IsIn(['REDUCE_EMI', 'REDUCE_TENURE'])
  recalc?: 'REDUCE_EMI' | 'REDUCE_TENURE';

  @ApiProperty({
    required: false,
    description:
      'Replay guard. A retried request carrying the same key cannot post the ' +
      'payment twice (unique on loan_transactions).',
  })
  @IsOptional()
  @IsUUID()
  idempotencyKey?: string;
}

export class ForecloseLoanDto {
  @ApiProperty({ required: false, default: false })
  @IsOptional()
  @IsBoolean()
  waiveFutureInterest?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Length(5, 500)
  reason?: string;
}

export class CloseLoanDto {
  @ApiProperty({ example: 'Residual 0.02 after final EMI' })
  @IsString()
  @Length(5, 500)
  reason: string;
}

export class WriteOffLoanDto {
  @ApiProperty({ required: false, description: 'Defaults to the full outstanding balance' })
  @IsOptional()
  @IsNumber(MONEY)
  @Min(0.01)
  @Max(MAX_MONEY)
  amount?: number;

  @ApiProperty({ example: 'Uncollectable after exit; approved by Finance ref FIN-123' })
  @IsString()
  @Length(10, 500)
  reason: string;
}

export class ReinstateLoanDto {
  @ApiProperty({ example: 'Employee rehired; debt reinstated per HR-88' })
  @IsString()
  @Length(5, 500)
  reason: string;
}

export class WaiveLoanDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber(MONEY)
  @Min(0.01)
  @Max(MAX_MONEY)
  amount?: number;

  @ApiProperty({ required: false, enum: ['INTEREST', 'PRINCIPAL', 'BOTH'] })
  @IsOptional()
  @IsIn(['INTEREST', 'PRINCIPAL', 'BOTH'])
  waiveType?: 'INTEREST' | 'PRINCIPAL' | 'BOTH';

  @ApiProperty({ example: 'Hardship waiver approved by HR' })
  @IsString()
  @Length(5, 500)
  reason: string;
}

export class HoldLoanDto {
  @ApiProperty({
    required: false,
    description: 'Omit to hold until explicitly resumed.',
  })
  @IsOptional()
  @IsDateString()
  until?: string;

  @ApiProperty({ example: 'Employee on unpaid sabbatical until March' })
  @IsString()
  @Length(5, 500)
  reason: string;
}

export class ResumeLoanDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Length(5, 500)
  reason?: string;
}

export class SkipInstallmentDto {
  @ApiProperty({
    required: false,
    description:
      'The user id of whoever authorised this restructure. Required while ' +
      '`loan_restructure_requires_approval` is on, must be an approver, and ' +
      'may not be the person performing it — no one person reshapes an agreed ' +
      'repayment plan alone.',
  })
  @IsOptional()
  @IsUUID()
  authorisedBy?: string;

  @ApiProperty({ example: 3 })
  @IsInt()
  @Min(1)
  @Max(600)
  installmentNo: number;

  @ApiProperty({
    required: false,
    enum: ['EXTEND', 'FORGIVE'],
    description:
      'EXTEND still owes the money and pushes the tail out; FORGIVE waives it.',
  })
  @IsOptional()
  @IsIn(['EXTEND', 'FORGIVE'])
  mode?: 'EXTEND' | 'FORGIVE';

  @ApiProperty({ example: 'Medical emergency, agreed with HR' })
  @IsString()
  @Length(5, 500)
  reason: string;
}

export class ConvertAdvanceDto {
  @ApiProperty({ example: 6 })
  @IsInt()
  @Min(1)
  @Max(600)
  installments: number;

  @ApiProperty({ required: false, example: 8.5 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Max(100)
  interestRate?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Length(5, 500)
  reason?: string;
}

/**
 * Changing the interest on a running loan.
 *
 * `LoanRateChange` is a complete model with **zero** code references, and
 * `LoanScheduleService.regenerate()` has accepted `newInterestRate` and
 * `newInterestMethod` from the start with nothing ever passing them — so a
 * floating rate, a mid-loan repricing and a correction to a mistyped rate were
 * all impossible through any surface.
 *
 * `mode` is what the borrower actually feels:
 *
 *  - **KEEP_TENURE** — the loan still ends when it was going to; the instalment
 *    moves. The usual choice, and the one a payroll deduction can absorb.
 *  - **KEEP_EMI** — the instalment stays where it is; the loan ends earlier or
 *    later. Chosen when the deduction is what the borrower budgeted around.
 */
export class LoanRateChangeDto {
  @ApiProperty({ enum: ['NONE', 'FLAT', 'REDUCING_BALANCE'], required: false })
  @IsOptional()
  @IsIn(['NONE', 'FLAT', 'REDUCING_BALANCE'])
  newMethod?: 'NONE' | 'FLAT' | 'REDUCING_BALANCE';

  @ApiProperty({ example: 9.5, description: 'Annual nominal rate, percent' })
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Max(100)
  newRate: number;

  @ApiProperty({
    enum: ['KEEP_TENURE', 'KEEP_EMI'],
    required: false,
    default: 'KEEP_TENURE',
  })
  @IsOptional()
  @IsIn(['KEEP_TENURE', 'KEEP_EMI'])
  mode?: 'KEEP_TENURE' | 'KEEP_EMI';

  @ApiProperty({
    example: '2026-09-01',
    required: false,
    description:
      'When the new rate takes effect. Recorded for the audit trail; instalments already ' +
      'settled are never re-priced, so this cannot reach into the past to change money ' +
      'that has moved.',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'effectiveFrom must be a calendar date, as YYYY-MM-DD',
  })
  effectiveFrom?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Length(5, 500)
  reason?: string;

  @ApiProperty({
    required: false,
    description:
      'The second approver, when `loan_restructure_requires_approval` is on: ' +
      'repricing a live loan is a restructure.',
  })
  @IsOptional()
  @IsUUID()
  authorisedBy?: string;
}

/**
 * Topping up a running loan.
 *
 * `LoanTransactionType.TOPUP_SETTLEMENT`, `LoanClosureType.TOPPED_UP`,
 * `approvalSource = 'TOPUP'` and both `loan_topup_*` settings existed with zero
 * implementing code — so a borrower who needed more had to run two loans side
 * by side, paying two instalments out of one salary, or clear the first from
 * savings they did not have.
 *
 * A top-up is one movement, not two: the new loan settles the old one's
 * balance, and only the difference reaches the employee.
 */
export class LoanTopupDto {
  @ApiProperty({
    example: 20000,
    description:
      'The TOTAL principal of the new loan, including whatever settles the ' +
      'existing balance — not the extra cash the employee receives.',
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(9999999999.99)
  amount: number;

  @ApiProperty({ example: 12 })
  @IsInt()
  @Min(1)
  @Max(600)
  installments: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Length(5, 500)
  reason?: string;

  @ApiProperty({
    required: false,
    description:
      'The second approver, when `loan_restructure_requires_approval` is on: a ' +
      'top-up replaces an agreed repayment plan.',
  })
  @IsOptional()
  @IsUUID()
  authorisedBy?: string;
}

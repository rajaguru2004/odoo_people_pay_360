import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

/**
 * Editing a request.
 *
 * There was no `PATCH /advance-loans/:id` at all: a submitted request could not
 * be corrected by anyone through any surface, so a typo'd amount meant cancel
 * and re-file — losing the queue position, the attachments and the audit thread.
 *
 * What may be edited depends on the STATUS, and the service enforces that; this
 * DTO only bounds the values. Nothing here can change whose loan it is: moving a
 * loan between employees is not an edit, it is a different loan.
 */
export class UpdateAdvanceLoanDto {
  @ApiPropertyOptional({ example: 25000 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(9999999999.99)
  amount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 1000)
  reason?: string;

  @ApiPropertyOptional({ example: 6 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(600)
  installments?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  loanTypeId?: string | null;

  @ApiPropertyOptional({ enum: ['NONE', 'FLAT', 'REDUCING_BALANCE'] })
  @IsOptional()
  @IsIn(['NONE', 'FLAT', 'REDUCING_BALANCE'])
  interestMethod?: 'NONE' | 'FLAT' | 'REDUCING_BALANCE';

  @ApiPropertyOptional({ example: 8.375 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Max(100)
  interestRate?: number;

  @ApiPropertyOptional({ enum: ['MONTHLY', 'WEEKLY', 'QUARTERLY'] })
  @IsOptional()
  @IsIn(['MONTHLY', 'WEEKLY', 'QUARTERLY'])
  deductionFrequency?: 'MONTHLY' | 'WEEKLY' | 'QUARTERLY';

  @ApiPropertyOptional({ example: '2026-08-01' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'effectiveDate must be a calendar date, as YYYY-MM-DD',
  })
  effectiveDate?: string;

  @ApiPropertyOptional({
    description: 'Recovery priority. ADMIN/HR only, like setting it at approval.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  priority?: number;

  @ApiPropertyOptional({
    description:
      'Why the request is being changed. Required once a loan is live, because ' +
      'the edit then alters an agreement somebody already accepted.',
  })
  @IsOptional()
  @IsString()
  @Length(5, 500)
  reason_for_change?: string;
}

/** The money that actually left the company, and when. */
export class DisburseLoanDto {
  @ApiPropertyOptional({
    example: '2026-08-15',
    description: 'Defaults to today. The schedule is rebuilt from this date.',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'disbursementDate must be a calendar date, as YYYY-MM-DD',
  })
  disbursementDate?: string;

  @ApiPropertyOptional({
    description:
      'What was actually paid out. Defaults to principal minus any processing ' +
      'fee taken at source. Stated explicitly when the bank moved a different ' +
      'figure — the loan still owes the full principal either way.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(9999999999.99)
  disbursedAmount?: number;

  @ApiPropertyOptional({ description: 'Bank reference for the payment' })
  @IsOptional()
  @IsString()
  @Length(1, 120)
  reference?: string;
}

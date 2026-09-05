import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  Matches,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export class CreateAdvanceLoanDto {
  @ApiProperty({
    example: 'ADVANCE',
    enum: ['ADVANCE', 'LOAN'],
    description: 'Request type',
  })
  @IsIn(['ADVANCE', 'LOAN'])
  type: 'ADVANCE' | 'LOAN';

  @ApiProperty({ example: 25000, description: 'Principal amount requested' })
  // Bounded exactly like `EligibilityCheckDto.amount` and the lifecycle money
  // DTOs — the two doors into the same money must not disagree.
  //
  // 2dp matches the Decimal(12,2) column: a bare `@IsNumber()` accepted 0.001,
  // wrote it, and the database rounded it, so the approved loan no longer said
  // what was requested. `@Max` is the field's own ceiling: without it
  // 9999999999.99+ was refused several layers later by the affordability check,
  // which told the requester about their take-home pay rather than about a
  // limit on the field they had just typed in.
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(9999999999.99)
  amount: number;

  @ApiProperty({
    example: 'Medical emergency',
    description: 'Reason for the request',
    required: false,
  })
  @IsOptional()
  @IsString()
  reason?: string;

  @ApiProperty({
    example: 6,
    description:
      'Proposed number of installments (loan only; the approver sets the final value)',
    required: false,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  installments?: number;

  @ApiProperty({
    description:
      'Loan product to borrow under. Its terms — interest, fees, grace, ' +
      'ceilings — are applied at creation and snapshotted onto the request at ' +
      'approval, so a later edit to the product cannot rewrite a live loan. ' +
      'Omitted, the request carries the column defaults exactly as before.',
    required: false,
  })
  @IsOptional()
  @IsUUID()
  loanTypeId?: string;

  // ── Terms ────────────────────────────────────────────────────────────────
  //
  // These four were reachable through no route at all. The amortisation engine
  // implements FLAT, REDUCING_BALANCE, WEEKLY, QUARTERLY and grace in full and
  // is well unit-tested; the only reason a natively filed loan was always
  // `NONE / 0 / MONTHLY` is that nothing could ask for anything else. The
  // importer and `convert` were the sole paths that could put a real rate on a
  // loan, which is why a bulk-migration endpoint became the de-facto factory
  // for half the module's states.
  //
  // Resolution order for each is: what was asked for here, then the product's
  // term, then the `loan_default_*` setting. Whatever wins is written onto the
  // request at filing, so the terms are fixed at the moment they are shown.

  @ApiProperty({
    enum: ['NONE', 'FLAT', 'REDUCING_BALANCE'],
    required: false,
    description:
      'Ignored while `loan_interest_enabled` is off — the switch coerces every ' +
      'new agreement to NONE rather than letting one state terms it will not charge.',
  })
  @IsOptional()
  @IsIn(['NONE', 'FLAT', 'REDUCING_BALANCE'])
  interestMethod?: 'NONE' | 'FLAT' | 'REDUCING_BALANCE';

  @ApiProperty({ example: 8.375, required: false, description: 'Annual nominal rate, percent' })
  @IsOptional()
  // 3dp matches `Decimal(6,3)`: a bare @IsNumber accepted 8.3751, wrote it, and
  // the column rounded it — so the loan charged a rate nobody agreed to.
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Max(100)
  interestRate?: number;

  @ApiProperty({
    enum: ['MONTHLY', 'WEEKLY', 'QUARTERLY'],
    required: false,
    description: 'Recovery cadence. The engine has always supported all three.',
  })
  @IsOptional()
  @IsIn(['MONTHLY', 'WEEKLY', 'QUARTERLY'])
  deductionFrequency?: 'MONTHLY' | 'WEEKLY' | 'QUARTERLY';

  @ApiProperty({
    example: 3,
    required: false,
    description:
      'Cycles before the first instalment falls due. Note that only the SHIFT ' +
      'is implemented today; `graceMode` (full vs interest-only moratorium) is ' +
      'not honoured by the engine.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(60)
  gracePeriods?: number;

  @ApiProperty({
    example: '2026-08-01',
    required: false,
    description:
      'The date the loan takes effect, and the anchor the schedule is built ' +
      'from. Bounded by `advance_loan_allow_backdated_days` (default 30) and ' +
      'by the employee’s joining date. Omitted, the loan starts today, which ' +
      'is what every natively created loan did — the DTO had no date field at ' +
      'all, so a loan could not be backdated to when the money actually moved ' +
      'nor future-dated to a cycle that has not started.',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'effectiveDate must be a calendar date, as YYYY-MM-DD',
  })
  effectiveDate?: string;

  @ApiProperty({
    required: false,
    default: false,
    description:
      'Save without submitting. `DRAFT` was rendered by the list screen and ' +
      'filterable in its toolbar while nothing could create one — the status ' +
      'was a promise the product did not keep. A draft notifies nobody and is ' +
      're-checked against eligibility when it is submitted.',
  })
  @IsOptional()
  @IsBoolean()
  draft?: boolean;
}

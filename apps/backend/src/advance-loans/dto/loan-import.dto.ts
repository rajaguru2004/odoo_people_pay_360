import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';

/**
 * One row of a loan import, as the client sends it back to `confirm`.
 *
 * This class exists for the SHAPE and the Swagger contract, not for the
 * business rules. The rules live in `validateImportRow()` in
 * `loan-import.service.ts` and are applied per row, on the server, by BOTH
 * `preview` and `confirm` — see the comment on `ConfirmLoanImportDto.rows` for
 * why they are deliberately not expressed as class-validator decorators here.
 */
export class LoanImportRowDto {
  @ApiProperty({ example: 'EMP-001' })
  employeeCode: string;

  @ApiProperty({ example: 'LN-2026-0001' })
  referenceNo: string;

  @ApiProperty({ enum: ['ADVANCE', 'LOAN'], example: 'LOAN' })
  type: string;

  @ApiProperty({ example: 120000 })
  principal: number;

  @ApiProperty({
    enum: ['NONE', 'FLAT', 'REDUCING_BALANCE'],
    example: 'NONE',
    description:
      'An interest-bearing method is REFUSED while `loan_interest_enabled` is ' +
      'off, rather than silently coerced to NONE — an import reproduces an ' +
      'agreement that already exists, and dropping its interest would change ' +
      'the opening balance it was migrated to preserve.',
  })
  interestMethod: string;

  @ApiProperty({ example: 0 })
  interestRate: number;

  @ApiProperty({ example: 12 })
  installments: number;

  @ApiPropertyOptional({
    example: null,
    description:
      'Optional. When given it is checked against the instalment the engine ' +
      'derives; it is never trusted in its place.',
  })
  emi?: number | null;

  @ApiProperty({ example: '2026-01-15', description: 'YYYY-MM-DD, a real calendar date.' })
  disbursedOn: string;

  @ApiProperty({
    example: '2026-02',
    description: 'YYYY-MM, a real calendar month, not before the month of `disbursedOn`.',
  })
  firstDeductionPeriod: string;

  @ApiProperty({ example: 0 })
  installmentsPaid: number;

  @ApiProperty({ example: 0 })
  amountRepaid: number;

  @ApiProperty({ enum: ['ACTIVE', 'CLOSED', 'ON_HOLD'], example: 'ACTIVE' })
  status: string;

  @ApiPropertyOptional({ example: 'Migrated from legacy system' })
  notes?: string;

  @ApiPropertyOptional({
    description:
      'Stamped by `preview` on every row it called valid. It binds the row to ' +
      'the preview that produced it: `confirm` recomputes it and refuses a row ' +
      'whose figures were changed afterwards. Always verified when present; ' +
      'REQUIRED when `loan_import_require_preview_signature` is `true`.',
  })
  signature?: string;
}

export class ConfirmLoanImportDto {
  /**
   * Rows to create.
   *
   * `@ValidateNested` is deliberately NOT used here, and the row rules are not
   * decorators. A ValidationPipe failure is one 400 for the whole request: with
   * `forbidNonWhitelisted` on, a single stray property in row 1,742 would
   * refuse the other 1,999 rows and report the fault as a flat list of
   * `rows.1742.<prop>` strings. This endpoint's contract is the opposite —
   * per-row results, so one bad row cannot cost an operator the rest of the
   * file. So the pipe checks only that the payload is an array of objects of a
   * sane size, and `validateImportRow()` — the SAME function `preview` runs —
   * decides each row and reports it in `results[]`.
   *
   * NOTE (not fixable here): `main.ts` caps the JSON body at 1 MB, so a wide
   * 2,000-row payload is refused by the body parser before this cap is ever
   * consulted. The advertised ceiling is only reachable for narrow rows.
   */
  @ApiProperty({
    type: [LoanImportRowDto],
    description:
      'The `data` objects from a preview response, `signature` included. Send ' +
      'only the rows you want created — the client is expected to filter out ' +
      'invalid ones, and the server re-validates every one of them regardless.',
  })
  @IsArray()
  @ArrayMaxSize(2000)
  @IsObject({ each: true, message: 'Each row must be an object' })
  rows: LoanImportRowDto[];

  @ApiPropertyOptional({
    description:
      'Optional. The `previewToken` returned by `preview`, echoed back for the ' +
      'server log so a confirmed batch can be traced to the file it came from.',
  })
  @IsOptional()
  @IsString()
  previewToken?: string;
}

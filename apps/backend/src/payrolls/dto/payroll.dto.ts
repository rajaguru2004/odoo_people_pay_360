import {
  IsInt,
  Min,
  Max,
  IsOptional,
  IsNumber,
  IsString,
  IsArray,
  IsIn,
  Length,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class CreatePayrollDto {
  @ApiProperty({ example: 1, description: 'Month (1-12)' })
  @IsInt()
  @Min(1)
  @Max(12)
  month: number;

  @ApiProperty({ example: 2026, description: 'Year' })
  @IsInt()
  @Min(2020)
  year: number;

  @ApiProperty({ example: 'batch-uuid', required: false, description: 'Payroll Batch ID' })
  @IsOptional()
  @IsString()
  batchId?: string;

  @ApiProperty({ example: ['employee-uuid'], required: false, description: 'Ad-hoc employee IDs' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  employeeIds?: string[];

  @ApiProperty({
    example: 'REGULAR',
    required: false,
    enum: ['REGULAR', 'OFF_CYCLE', 'BONUS', 'ADJUSTMENT', 'FINAL_SETTLEMENT'],
    description:
      'What kind of run this is. Defaults to REGULAR.',
  })
  @IsOptional()
  @IsIn(['REGULAR', 'OFF_CYCLE', 'BONUS', 'ADJUSTMENT', 'FINAL_SETTLEMENT'])
  runType?: 'REGULAR' | 'OFF_CYCLE' | 'BONUS' | 'ADJUSTMENT' | 'FINAL_SETTLEMENT';
}

export const PAYROLL_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'LOCKED',
] as const;

/**
 * The query of `GET /payrolls`.
 *
 * A class rather than an inline object type on purpose: NestJS's ValidationPipe
 * has nothing to validate against a bare TS type, so `status` used to be cast
 * straight to `PayrollStatus` and an unknown value reached Prisma — turning a
 * client typo into a 500 the server reported as a fault of its own.
 */
export class ListPayrollsQueryDto {
  // A FILTER, not a creation field: any well-formed year is a legitimate thing
  // to ask about and answers with an empty list. The narrow @Min(2020) belongs
  // on CreatePayrollDto, where the year decides what gets paid.
  @ApiProperty({ required: false, example: 2026 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1900)
  @Max(2999)
  year?: number;

  @ApiProperty({ required: false, enum: PAYROLL_STATUSES })
  @IsOptional()
  @IsIn(PAYROLL_STATUSES as unknown as string[])
  status?: (typeof PAYROLL_STATUSES)[number];
}

export class UpdatePayrollItemDto {
  @ApiProperty({ example: 500000, required: false, description: 'Allowances' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  allowances?: number;

  @ApiProperty({ example: 1000000, required: false, description: 'Bonus' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  bonus?: number;

  @ApiProperty({ example: 200000, required: false, description: 'Deduction' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  deduction?: number;

  @ApiProperty({ example: 10, required: false, description: 'Overtime hours' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  overtimeHours?: number;

  @ApiProperty({ example: 150, required: false, description: 'Food allowance' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  foodAllowance?: number;

  @ApiProperty({
    example: 25,
    required: false,
    description: 'Site allowance (summed from approved overtime unless set here)',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  siteAllowance?: number;

  @ApiProperty({ example: 'Project bonus', required: false })
  @IsOptional()
  @IsString()
  notes?: string;
}

export class UnlockPayrollDto {
  @ApiProperty({
    example: 'Overtime hours were wrong for 3 employees',
    description:
      'Why the payroll is being reversed. Recorded on the payroll, so a ' +
      'restated payslip is always explainable.',
  })
  @IsString()
  @Length(5, 500)
  reason: string;
}

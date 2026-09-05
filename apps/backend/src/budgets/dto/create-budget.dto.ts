import { IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, MaxLength, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const BUDGET_STATUSES = ['DRAFT', 'ACTIVE', 'CLOSED'] as const;

export class CreateBudgetDto {
  @ApiProperty({ example: 'FY2027 Operating Budget' })
  @IsString()
  @MaxLength(200)
  name: string;

  @ApiProperty({ example: 2027 })
  @IsInt()
  @Min(2000)
  fiscalYear: number;

  @ApiProperty({
    example: '2027-01-01',
    description: 'Fiscal, not calendar — a fiscal year need not start in January',
  })
  @IsDateString()
  startDate: string;

  @ApiProperty({ example: '2027-12-31' })
  @IsDateString()
  endDate: string;

  @ApiProperty()
  @IsUUID()
  branchId: string;

  @ApiPropertyOptional({
    default: 'OMR',
    description: 'One budget = one currency; amounts are never summed across currencies',
  })
  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  @ApiPropertyOptional({
    enum: BUDGET_STATUSES,
    default: 'DRAFT',
    description: 'Only an ACTIVE budget attracts commitments',
  })
  @IsOptional()
  @IsIn(BUDGET_STATUSES as unknown as string[])
  status?: string;
}

/**
 * The status change, as a DTO rather than a bare `@Body('status')` string.
 *
 * `@Body('status')` reaches into the payload and bypasses `ValidationPipe`
 * entirely, so `forbidNonWhitelisted` never ran on this route and unknown
 * properties were silently accepted and ignored — the only write in the module
 * that behaved that way.
 */
export class SetBudgetStatusDto {
  @ApiProperty({ enum: BUDGET_STATUSES })
  @IsIn(BUDGET_STATUSES as unknown as string[], {
    message: 'Status must be DRAFT, ACTIVE or CLOSED',
  })
  status: string;
}

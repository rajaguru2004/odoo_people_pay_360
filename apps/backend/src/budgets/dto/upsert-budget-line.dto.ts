import { IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpsertBudgetLineDto {
  @ApiPropertyOptional({
    description:
      'Omit for the company-wide fallback line — what spend attaches to when no department line matches',
  })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiProperty({ description: 'BUDGET_CATEGORY library label, e.g. "Travel"' })
  @IsString()
  @MaxLength(100)
  category: string;

  @ApiProperty({ example: 25000 })
  @IsNumber()
  @Min(0)
  plannedAmount: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

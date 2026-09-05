import { IsInt, Min, IsOptional, IsUUID, IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CopyYearDto {
  @ApiProperty({ example: 2025, description: 'Year to copy holidays from' })
  @IsInt()
  @Min(2020)
  fromYear: number;

  @ApiProperty({ example: 2026, description: 'Year to copy holidays into' })
  @IsInt()
  @Min(2020)
  toYear: number;

  @ApiProperty({
    required: false,
    description: 'Limit to a single branch scope. Omit = all scopes (global + every branch).',
  })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiProperty({
    required: false,
    description: 'Only copy holidays flagged isRecurring',
  })
  @IsOptional()
  @IsBoolean()
  onlyRecurring?: boolean;
}

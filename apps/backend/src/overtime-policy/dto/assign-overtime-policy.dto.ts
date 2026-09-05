import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/**
 * Assign an employment type and/or a direct policy override to one employee.
 * `overtimePolicyId: null` clears the override (falling back to type → default).
 */
export class AssignOvertimePolicyDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  employeeId: string;

  @ApiPropertyOptional({ description: 'Contract Type library label, e.g. "Daily Wage"' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  employmentType?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: 'Direct policy override; null clears it',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID()
  overtimePolicyId?: string | null;
}

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
 *
 * `overtimePolicyId: null` CLEARS the override, dropping the employee back to
 * their employment type and then to the company default. That is why null has to
 * be distinguishable from an absent field here.
 */
export class AssignOvertimePolicyDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  employeeId: string;

  @ApiPropertyOptional({
    description: 'An EMPLOYMENT_TYPE library label, e.g. "Daily Wage"',
  })
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

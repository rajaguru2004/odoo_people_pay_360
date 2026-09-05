import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/**
 * Set an employee's employment type and/or their direct policy override.
 *
 * `overtimePolicyId: null` clears the override, which drops the employee back
 * onto the employment-type policy and then the company default — the point of
 * a nullable column rather than a "None" policy row nobody can delete.
 */
export class AssignOvertimePolicyDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  employeeId: string;

  @ApiPropertyOptional({
    description:
      'The EMPLOYMENT_TYPE library label this employee is on, matched against a policy scoped to that type. Omitted leaves it as it is; the middle tier is skipped while it is unset.',
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

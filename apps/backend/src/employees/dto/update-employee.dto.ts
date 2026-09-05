import {
  IsString,
  IsEmail,
  IsDateString,
  IsEnum,
  IsOptional,
  IsUUID,
  IsNumber,
  IsObject,
  IsIn,
  Min,
  MaxLength,
  Matches,
  ValidateIf,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateEmployeeDto {
  @ApiProperty({ example: 'EMP-001', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  employeeCode?: string;

  @ApiProperty({ example: 'John Doe', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  fullName?: string;

  @ApiProperty({ example: '1990-01-15', required: false })
  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;

  @ApiProperty({
    example: 'MALE',
    enum: ['MALE', 'FEMALE', 'OTHER'],
    required: false,
  })
  @IsOptional()
  @IsEnum(['MALE', 'FEMALE', 'OTHER'])
  gender?: string;

  @ApiProperty({ example: '001234567890', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  idCard?: string;

  @ApiProperty({ example: 'Hanoi', required: false })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiProperty({ example: '0912345678', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @ApiProperty({
    example: 'OM',
    required: false,
    description:
      'ISO-3166 alpha-2 country of the phone number. Send an empty string to clear it and ' +
      'fall back to branch country / the global WhatsApp default region.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^([A-Za-z]{2})?$/, { message: 'phoneCountryCode must be an ISO-3166 alpha-2 code' })
  phoneCountryCode?: string;

  @ApiProperty({ example: 'nva@company.com', required: false })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({
    example: '11111111-1111-1111-1111-111111111111',
    required: false,
  })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiProperty({ example: 'Senior Software Engineer', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  position?: string;

  @ApiProperty({ example: '2024-12-31', required: false })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiProperty({
    example: 'ACTIVE',
    enum: ['ACTIVE', 'INACTIVE', 'ON_LEAVE', 'TERMINATED'],
    required: false,
  })
  @IsOptional()
  @IsEnum(['ACTIVE', 'INACTIVE', 'ON_LEAVE', 'TERMINATED'])
  status?: string;

  @ApiProperty({
    example: 18000000,
    required: false,
    description:
      'Contracted rate — a MONTHLY amount, or a PER-DAY rate when salaryType is DAILY.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  baseSalary?: number;

  @ApiProperty({
    required: false,
    enum: ['MONTHLY', 'DAILY'],
    description:
      'Pay basis. DAILY = daily wage, paid strictly for days actually worked.',
  })
  @IsOptional()
  @IsIn(['MONTHLY', 'DAILY'])
  salaryType?: 'MONTHLY' | 'DAILY';

  @ApiProperty({ example: 'Asia/Kolkata', required: false })
  @IsOptional()
  @IsString()
  timezone?: string | null;

  @ApiProperty({ example: 'DD/MM/YYYY', required: false })
  @IsOptional()
  @IsString()
  dateFormat?: string | null;

  // ── Fields the Employee Profile Template places on the edit form ──────────
  // Bound to real employee columns and rendered by the form, but undeclared
  // here — so filling any of them in failed the whole PATCH under
  // forbidNonWhitelisted. `branchId` and `startDate` are deliberately still
  // absent: moving an employee between branches crosses the isolation axis and
  // changing a start date rewrites payroll history, so both need their own
  // reviewed flow rather than a field on this form.

  @ApiProperty({
    required: false,
    description: 'Photo URL, as returned by the upload endpoints.',
  })
  @IsOptional()
  @IsString()
  avatarUrl?: string;

  @ApiProperty({
    required: false,
    nullable: true,
    description:
      'Approval supervisor (Employee UUID); null clears the assignment.',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID()
  supervisorId?: string | null;

  @ApiProperty({
    required: false,
    nullable: true,
    description:
      "Identity inside the branch's external attendance provider; null unlinks it.",
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(100)
  attendanceExternalId?: string | null;

  @ApiProperty({
    required: false,
    description:
      'EMPLOYMENT_TYPE library label. When that library item carries a pay ' +
      'basis it DERIVES salaryType; sending a conflicting salaryType is rejected.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  employmentType?: string;

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'Overtime Policy override; null clears it',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID()
  overtimePolicyId?: string | null;

  @ApiProperty({
    required: false,
    type: Object,
    description:
      'Values for Employee Profile Template fields stored as JSONB (the fields an ' +
      'admin added). Keyed by fieldKey. A single declared property on purpose: the ' +
      'global ValidationPipe runs with forbidNonWhitelisted, so loose top-level keys ' +
      'would be rejected before reaching the service. Rejected entirely while ' +
      'employee_template_enabled is off.',
  })
  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;
}

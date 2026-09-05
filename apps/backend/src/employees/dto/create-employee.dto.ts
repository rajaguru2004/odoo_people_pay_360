import {
  IsString,
  IsEmail,
  IsDateString,
  IsEnum,
  IsOptional,
  IsUUID,
  IsNumber,
  IsBoolean,
  IsObject,
  IsIn,
  Min,
  MaxLength,
  Matches,
  ValidateIf,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateEmployeeDto {
  @ApiProperty({ example: 'John Doe', description: 'Full name of employee' })
  @IsString()
  @MaxLength(255)
  fullName: string;

  @ApiProperty({
    example: '1990-01-15',
    description: 'Date of birth (YYYY-MM-DD)',
  })
  @IsDateString()
  dateOfBirth: string;

  @ApiProperty({
    example: 'MALE',
    enum: ['MALE', 'FEMALE', 'OTHER'],
    required: false,
  })
  @IsOptional()
  @IsEnum(['MALE', 'FEMALE', 'OTHER'])
  gender?: string;

  @ApiProperty({
    example: '001234567890',
    required: false,
    description:
      'ID card number (CCCD/CMND). Required UNLESS `autoGenerateIdCard` is set, in which ' +
      'case the server mirrors it from the generated employee code.',
  })
  // Optional only when the caller has asked the server to generate it. Without
  // this the flag was unusable: `autoGenerateIdCard: true` with no idCard was
  // rejected at validation with "idCard must be a string", so the one caller
  // that opts in still had to invent a value for a field it never shows the
  // user. Every other caller — bulk import, the API — is unaffected and still
  // has to supply a real one.
  @ValidateIf((o) => !o.autoGenerateIdCard)
  @IsString()
  @MaxLength(50)
  idCard: string;

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
      'ISO-3166 alpha-2 country of the phone number. Only used when `phone` was typed ' +
      'without a country prefix. Omit to fall back to branch country, then the global ' +
      'WhatsApp default region.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{2}$/, { message: 'phoneCountryCode must be an ISO-3166 alpha-2 code' })
  phoneCountryCode?: string;

  @ApiProperty({ example: 'nva@company.com', description: 'Employee email' })
  @IsEmail()
  email: string;

  @ApiProperty({
    example: '11111111-1111-1111-1111-111111111111',
    description: 'Department ID',
  })
  @IsUUID()
  departmentId: string;

  @ApiProperty({
    example: '22222222-2222-2222-2222-222222222222',
    description: 'Branch ID (defaults to the caller active branch / Head Office)',
    required: false,
  })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiProperty({ example: 'Software Engineer', description: 'Job position' })
  @IsString()
  @MaxLength(100)
  position: string;

  @ApiProperty({
    example: '2024-01-01',
    description: 'Start date (YYYY-MM-DD)',
  })
  @IsDateString()
  startDate: string;

  @ApiProperty({
    example: 15000000,
    description:
      'Contracted rate. A MONTHLY amount when salaryType is MONTHLY, a PER-DAY rate when salaryType is DAILY.',
  })
  @IsNumber()
  @Min(0)
  baseSalary: number;

  @ApiProperty({
    required: false,
    enum: ['MONTHLY', 'DAILY'],
    default: 'MONTHLY',
    description:
      'Pay basis. MONTHLY = fixed monthly salary with Loss-of-Pay on absence. ' +
      'DAILY = daily wage, paid strictly for days actually worked (baseSalary is then a per-day rate).',
  })
  @IsOptional()
  @IsIn(['MONTHLY', 'DAILY'])
  salaryType?: 'MONTHLY' | 'DAILY';

  @ApiProperty({ example: 'Asia/Kolkata', required: false })
  @IsOptional()
  @IsString()
  timezone?: string | null;

  // ── Fields the Employee Profile Template places on the create form ────────
  // The template ships these as baseline fields bound to real employee columns,
  // but the DTO did not declare them — and the global pipe runs with
  // forbidNonWhitelisted, so filling any of them in made the whole create fail
  // with "property … should not exist". Declared here so the form can offer
  // what it renders.

  @ApiProperty({
    required: false,
    enum: ['ACTIVE', 'INACTIVE', 'TERMINATED', 'ON_LEAVE'],
    default: 'ACTIVE',
  })
  @IsOptional()
  @IsIn(['ACTIVE', 'INACTIVE', 'TERMINATED', 'ON_LEAVE'])
  status?: string;

  @ApiProperty({
    required: false,
    description: 'End date (YYYY-MM-DD) for a fixed-term hire.',
  })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiProperty({
    required: false,
    description: 'Photo URL, as returned by the upload endpoints.',
  })
  @IsOptional()
  @IsString()
  avatarUrl?: string;

  @ApiProperty({
    required: false,
    description:
      'Approval supervisor (Employee UUID). A dynamic assignment, not an RBAC role.',
  })
  @IsOptional()
  @IsUUID()
  supervisorId?: string;

  @ApiProperty({
    required: false,
    enum: ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'],
    description: 'Personal date-display preference. Omit to inherit the app default.',
  })
  @IsOptional()
  @IsIn(['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'])
  dateFormat?: string | null;

  @ApiProperty({
    required: false,
    description:
      "Identity inside the branch's external attendance provider. Usually auto-matched on employee code.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  attendanceExternalId?: string;

  @ApiProperty({
    required: false,
    description:
      'Employment classification — an EMPLOYMENT_TYPE library label. Drives ' +
      'Overtime Policy resolution, and when that library item carries a pay ' +
      'basis it also DERIVES salaryType, overriding any salaryType sent here.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  employmentType?: string;

  @ApiProperty({
    required: false,
    description: 'Overtime Policy override (highest-priority tier). Omit to inherit by employment type / default.',
  })
  @IsOptional()
  @IsUUID()
  overtimePolicyId?: string;

  @ApiProperty({
    required: false,
    description:
      'Set when idCard was auto-filled from the generated employee code rather than typed by the caller. ' +
      'On a uniqueness collision, the server regenerates the code/idCard and retries instead of rejecting ' +
      'the request — never set this for bulk import rows carrying real ID card numbers.',
  })
  @IsOptional()
  @IsBoolean()
  autoGenerateIdCard?: boolean;

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

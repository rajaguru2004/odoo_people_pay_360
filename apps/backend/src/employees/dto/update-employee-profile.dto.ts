import {
  IsDateString,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateEmployeeProfileDto {
  // Personal Information
  @IsOptional()
  @IsString()
  placeOfBirth?: string;

  @IsOptional()
  @IsString()
  nationality?: string;

  /**
   * ISO-3166 alpha-2, uppercase.
   *
   * Separate from the free-text `nationality` above, which defaults to 'Vietnam'
   * and cannot drive a statutory rule. End-of-service reads this one.
   */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{2}$/, {
    message:
      'nationalityCode must be an uppercase ISO-3166 alpha-2 code, e.g. OM. ' +
      'Every country-scoped table in this system keys on that form, so a ' +
      'lowercase or three-letter code would silently match no rule at all.',
  })
  nationalityCode?: string;

  /**
   * NATIONAL | GCC | EXPAT.
   *
   * Left optional on purpose: NULL means UNKNOWN, and end-of-service refuses to
   * accrue for an unknown class rather than guessing at a statutory entitlement.
   * Forcing a value here would replace "unknown" with a guess for every existing
   * employee on the day it shipped.
   */
  @IsOptional()
  @IsIn(['NATIONAL', 'GCC', 'EXPAT'])
  nationalityClass?: string;

  @IsOptional()
  @IsString()
  ethnicity?: string;

  @IsOptional()
  @IsString()
  religion?: string;

  @IsOptional()
  @IsString()
  maritalStatus?: string; // SINGLE, MARRIED, DIVORCED, WIDOWED

  @IsOptional()
  @IsInt()
  @Min(0)
  numberOfChildren?: number;

  // Address Details
  @IsOptional()
  @IsString()
  permanentAddress?: string;

  @IsOptional()
  @IsString()
  temporaryAddress?: string;

  // Government IDs
  @IsOptional()
  @IsString()
  socialInsuranceNumber?: string;

  @IsOptional()
  @IsString()
  taxCode?: string;

  @IsOptional()
  @IsString()
  healthInsuranceNumber?: string;

  @IsOptional()
  @IsString()
  passportNumber?: string;

  @IsOptional()
  @IsDateString()
  passportExpiry?: string;

  // Emergency Contact
  @IsOptional()
  @IsString()
  emergencyContactName?: string;

  @IsOptional()
  @IsString()
  emergencyContactRelationship?: string;

  @IsOptional()
  @IsString()
  emergencyContactPhone?: string;

  @IsOptional()
  @IsString()
  emergencyContactAddress?: string;

  // Education
  @IsOptional()
  @IsString()
  highestEducation?: string; // HIGH_SCHOOL, ASSOCIATE, BACHELOR, MASTER, PHD

  @IsOptional()
  @IsString()
  major?: string;

  @IsOptional()
  @IsString()
  university?: string;

  @IsOptional()
  @IsInt()
  @Min(1950)
  @Max(2100)
  graduationYear?: number;

  @IsOptional()
  @IsString()
  professionalCertificates?: string; // JSON string

  // Bank Information
  @IsOptional()
  @IsString()
  bankName?: string;

  @IsOptional()
  @IsString()
  bankAccountNumber?: string;

  @IsOptional()
  @IsString()
  bankAccountHolderName?: string;

  @IsOptional()
  @IsString()
  bankBranch?: string;

  // Work Experience
  @IsOptional()
  workExperience?: any; // JSON object

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

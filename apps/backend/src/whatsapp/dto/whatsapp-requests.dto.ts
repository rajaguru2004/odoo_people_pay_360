import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';

/** Step 1 of self opt-in: the raw number as the employee typed it. */
export class OptInPreviewDto {
  @ApiProperty({ example: '+968 9001 0000' })
  @IsString()
  @MinLength(5)
  @MaxLength(30)
  phone: string;
}

/**
 * Step 2 of self opt-in: the normalised number the server showed back.
 * Two steps by design — the employee confirms the exact E.164 before consent is
 * recorded, so a normalisation mistake becomes a visible correction rather than
 * a message to a stranger.
 */
export class OptInConfirmDto {
  @ApiProperty({ example: '+96890010000', description: 'The E.164 returned by the preview step.' })
  @IsString()
  @MinLength(8)
  @MaxLength(20)
  phoneE164: string;
}

export class TestSendDto {
  @ApiPropertyOptional({ description: 'Defaults to the configured admin number.' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @ApiPropertyOptional({ description: 'Template key to render a sample of.' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  templateKey?: string;

  @ApiPropertyOptional({ description: 'Render only; do not send.' })
  @IsOptional()
  @IsBoolean()
  previewOnly?: boolean;
}

export class QueryOutboxDto {
  @ApiPropertyOptional({ enum: ['QUEUED', 'SENDING', 'SENT', 'FAILED', 'SKIPPED'] })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  templateKey?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  take?: number;
}

export class QueryIdentitiesDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  optedIn?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  verified?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  take?: number;
}

/** Step 1 of linking a handset: the number the employee typed. */
export class EnrollStartDto {
  @ApiProperty({ example: '+91 99529 82836' })
  @IsString()
  @MinLength(5)
  @MaxLength(30)
  phone: string;
}

/** Step 2: the code we sent, typed back on the WEB page (never over WhatsApp). */
export class EnrollVerifyDto {
  @ApiProperty()
  @IsString()
  enrollmentId: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  @MinLength(4)
  @MaxLength(10)
  code: string;
}

/**
 * Bulk-link the phone numbers already held on employee records.
 *
 * Dry-run by default: `commit` has to be asked for, so an operator can see
 * exactly which numbers are unreadable or shared before anything is written.
 */
export class EnrollFromEmployeesDto {
  @ApiPropertyOptional({
    description: 'Write the rows. Omit for a report of what would happen.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  commit?: boolean;

  @ApiPropertyOptional({
    description:
      'Record the numbers as opted IN, with source ADMIN — the employer asserting consent ' +
      'on the employee’s behalf. Without it the numbers are linked and confirmed but stay ' +
      'opted out, so nothing is delivered until each person opts in from their profile.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  confirmConsent?: boolean;

  @ApiPropertyOptional({ description: 'Limit to these employees. Omit for everyone active.' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(2000)
  employeeIds?: string[];
}

export class SetPinDto {
  @ApiProperty({ example: '482915', description: '6 digits. Never accepted over WhatsApp.' })
  @IsString()
  @MinLength(6)
  @MaxLength(6)
  pin: string;
}

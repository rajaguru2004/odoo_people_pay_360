import {
  IsDateString,
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * What a person may change about themselves.
 *
 * Deliberately narrow. Reaching your own profile is not the same as being
 * allowed to write every field on it: position, department, hire date, national
 * id and status are all things the business asserts about somebody, and an
 * employee editing them would be editing the record rather than their contact
 * details. Those stay on `PATCH /employees/:id`, which is HR's door.
 *
 * `ValidationPipe` runs with `forbidNonWhitelisted`, so anything absent from
 * this class is a 400 rather than a silently ignored field — which is the whole
 * point of listing them here.
 */
export class UpdateEmployeeProfileDto {
  @ApiPropertyOptional({ example: '+968 9123 4567' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  @ApiPropertyOptional({ description: 'Where to reach them off the clock.' })
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  personalEmail?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  address?: string;

  @ApiPropertyOptional({
    description: 'Date only — no time of day, and never zone-converted.',
  })
  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;

  @ApiPropertyOptional({ example: 'Female' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  gender?: string;

  @ApiPropertyOptional({ example: 'OM', description: 'ISO-3166 alpha-2.' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{2}$/, {
    message:
      'nationality must be an uppercase ISO-3166 alpha-2 code, e.g. OM — every country-scoped lookup keys on that form',
  })
  nationality?: string;

  @ApiPropertyOptional({
    example: 'Asia/Muscat',
    description:
      'Personal IANA zone. Clear it to fall back to the branch, then the company.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;
}

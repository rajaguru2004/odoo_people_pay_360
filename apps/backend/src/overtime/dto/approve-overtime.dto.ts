import { ApiProperty } from '@nestjs/swagger';
import {
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Approver-supplied corrections carried on `POST /overtime/:id/approve`.
 *
 * Every field is optional and the body itself may be absent entirely — a plain
 * bodyless approve must keep meaning "approve exactly as filed".
 *
 * Note what is NOT here: `hours` and `date`. Hours are derived from the worked
 * window by the same tier/boundary engine that classified the request, so a
 * typed figure could disagree with the times it is supposed to summarize; and
 * moving a request to another date would collide with the one-request-per-date
 * rule and rewrite which day's rest-day/holiday premium applies. `reason` is
 * the employee's own words and is not the approver's to rewrite.
 */
export class ApproveOvertimeDto {
  @ApiProperty({
    example: '2026-08-20T18:00:00Z',
    required: false,
    description:
      'Corrected start of the worked window. Wall-clock tagged UTC, as filed.',
  })
  @IsOptional()
  @IsDateString()
  startTime?: string;

  @ApiProperty({
    example: '2026-08-20T23:00:00Z',
    required: false,
    description:
      'Corrected end of the worked window. An end at or before the start is ' +
      'read as crossing midnight, exactly as it is at submission.',
  })
  @IsOptional()
  @IsDateString()
  endTime?: string;

  @ApiProperty({
    example: 150,
    required: false,
    description:
      'Overrides the policy-computed food allowance. Absent means the policy ' +
      'decides; 0 is a real value that suppresses an allowance the policy ' +
      'would otherwise grant.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  foodAllowance?: number;

  @ApiProperty({
    example: 25,
    required: false,
    description:
      'Site allowance granted for this request. Requires ' +
      'overtime_site_allowance_enabled and is capped by ' +
      'overtime_site_allowance_max when that is non-zero.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  siteAllowance?: number;

  @ApiProperty({
    example: 'Offshore rig — night access',
    required: false,
    description: 'Why the site allowance was granted.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  siteAllowanceNote?: string;

  @ApiProperty({
    example: 'Employee wrote 22:00; gate log shows 23:00.',
    required: false,
    description: 'Why the approver changed the request.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  approverNote?: string;

  @ApiProperty({
    example: '2026-08-20T11:04:22.581Z',
    required: false,
    description:
      'The updatedAt the approver was looking at. Sent back so a second ' +
      'approver editing the same request concurrently is refused with a 409 ' +
      'instead of silently overwriting the first one.',
  })
  @IsOptional()
  @IsDateString()
  expectedUpdatedAt?: string;
}

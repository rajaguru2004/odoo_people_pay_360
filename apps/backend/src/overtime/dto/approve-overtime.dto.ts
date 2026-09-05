import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Approver corrections, carried on `POST /overtime/:id/approve`.
 *
 * Every field is optional and the body may be absent entirely — a plain approve
 * has to keep meaning "approve exactly as filed".
 *
 * Note what is NOT here. `hours` is derived from the worked window by the same
 * engine that classified the request, so a typed figure could disagree with the
 * times it is meant to summarize. `date` is absent because moving a request to
 * another day would collide with the one-request-per-date rule and silently
 * change which day's rest-day or holiday premium applies. `reason` is the
 * employee's own words and is not the approver's to rewrite.
 */
export class ApproveOvertimeDto {
  @ApiPropertyOptional({
    example: '2026-08-20T18:00:00Z',
    description: 'Corrected start of the worked window.',
  })
  @IsOptional()
  @IsDateString()
  startTime?: string;

  @ApiPropertyOptional({
    example: '2026-08-20T23:00:00Z',
    description:
      'Corrected end. An end at or before the start is read as crossing midnight, exactly as at submission.',
  })
  @IsOptional()
  @IsDateString()
  endTime?: string;

  @ApiPropertyOptional({
    example: 3,
    description:
      'Overrides the policy-computed food allowance. Absent means the policy ' +
      'decides; 0 is a real value that suppresses an allowance the policy would grant.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  foodAllowance?: number;

  @ApiPropertyOptional({
    example: 5,
    description:
      'Site allowance for this request. Requires overtime_site_allowance_enabled ' +
      'and is capped by overtime_site_allowance_max when that is non-zero.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  siteAllowance?: number;

  @ApiPropertyOptional({ example: 'Offshore rig — night access' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  siteAllowanceNote?: string;

  @ApiPropertyOptional({
    example: 'Employee wrote 22:00; the gate log shows 23:00.',
    description: 'Why the approver changed the request.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  approverNote?: string;

  @ApiPropertyOptional({
    example: '2026-08-20T11:04:22.581Z',
    description:
      'The updatedAt the approver was looking at. Sent back so a second ' +
      'approver editing the same request concurrently is refused with a 409 ' +
      'rather than silently overwriting the first one.',
  })
  @IsOptional()
  @IsDateString()
  expectedUpdatedAt?: string;
}

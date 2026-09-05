import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { HolidayBehaviorEnum } from '../overtime-policy.types';

const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;
const HHMM_MSG = 'must be a time in HH:MM (24h) format';

export class RateTierDto {
  @ApiPropertyOptional({ example: 2 })
  @IsNumber()
  @Min(0)
  regularRate: number;

  @ApiPropertyOptional({ example: 2 })
  @IsNumber()
  @Min(0)
  lateRate: number;

  @ApiPropertyOptional({ example: '22:00' })
  @IsString()
  @Matches(HHMM, { message: `lateThreshold ${HHMM_MSG}` })
  lateThreshold: string;
}

/**
 * Validation for the `rules` blob.
 *
 * Every field is optional: a create or update payload may name three fields, and
 * the service composes them over the defaults derived from the current global
 * configuration. That is what keeps a half-filled form from producing a policy
 * whose unmentioned rates are zero.
 */
export class OvertimePolicyRulesDto {
  @ApiPropertyOptional({ description: 'Per-policy overtime eligibility gate' })
  @IsOptional()
  @IsBoolean()
  eligible?: boolean;

  @ApiPropertyOptional({
    enum: HolidayBehaviorEnum,
    description:
      'STANDARD pays the holiday premium tier; IGNORE treats a holiday as an ordinary weekday',
  })
  @IsOptional()
  @IsEnum(HolidayBehaviorEnum)
  holidayBehavior?: HolidayBehaviorEnum;

  @ApiPropertyOptional({ example: '22:00' })
  @IsOptional()
  @IsString()
  @Matches(HHMM, { message: `lateThreshold ${HHMM_MSG}` })
  lateThreshold?: string;

  @ApiPropertyOptional({ example: 1.25 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  regularRate?: number;

  @ApiPropertyOptional({ example: 1.5 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  lateRate?: number;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  doubleOtEnabled?: boolean;

  @ApiPropertyOptional({ example: 2 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  doubleRate?: number;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  doubleOtAllowAnytime?: boolean;

  @ApiPropertyOptional({ type: RateTierDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => RateTierDto)
  sunday?: RateTierDto;

  @ApiPropertyOptional({ type: RateTierDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => RateTierDto)
  holiday?: RateTierDto;

  @ApiPropertyOptional({ example: '17:00' })
  @IsOptional()
  @IsString()
  @Matches(HHMM, { message: `shiftEndTime ${HHMM_MSG}` })
  shiftEndTime?: string;

  @ApiPropertyOptional({
    example: '23:59',
    nullable: true,
    description: 'Per-policy day-boundary override; null inherits the global',
  })
  @IsOptional()
  // null is a deliberate "inherit the global", not a missing value.
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @Matches(HHMM, { message: `dayEndBoundary ${HHMM_MSG}` })
  dayEndBoundary?: string | null;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  foodAllowanceEnabled?: boolean;

  @ApiPropertyOptional({ example: 3 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  foodAllowanceAmount?: number;

  @ApiPropertyOptional({ example: '22:00' })
  @IsOptional()
  @IsString()
  @Matches(HHMM, { message: `foodAllowanceThreshold ${HHMM_MSG}` })
  foodAllowanceThreshold?: string;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  doubleFoodAllowanceAnyTime?: boolean;

  @ApiPropertyOptional({ example: 4 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  maxHoursPerDay?: number;

  @ApiPropertyOptional({ example: 12 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  maxHoursPerDoubleDay?: number;

  @ApiPropertyOptional({ example: 30 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  maxHoursPerMonth?: number;

  @ApiPropertyOptional({ example: 200 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  maxHoursPerYear?: number;
}

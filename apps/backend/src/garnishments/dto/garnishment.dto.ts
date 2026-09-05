import { ApiProperty, ApiPropertyOptional, PartialType, OmitType } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

/**
 * A court-ordered attachment of earnings.
 *
 * Exactly one of `amount` and `percentOfNet` carries the instruction — an order
 * that says both, or neither, is not an instruction anyone can follow, so the
 * service refuses it rather than guessing.
 */
export class CreateGarnishmentDto {
  @ApiProperty()
  @IsUUID()
  employeeId: string;

  @ApiProperty({ example: 'CIV/2026/8891', description: 'Court or authority reference' })
  @IsString()
  @Length(1, 120)
  reference: string;

  @ApiPropertyOptional({ example: 'District Court, Muscat' })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  authority?: string;

  @ApiPropertyOptional({ description: 'Fixed amount per cycle' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(9999999999.99)
  amount?: number;

  @ApiPropertyOptional({ description: 'Share of net pay per cycle, 0-100' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(100)
  percentOfNet?: number;

  @ApiPropertyOptional({ description: 'Stop once this much has been collected in total' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(9999999999.99)
  totalCap?: number;

  @ApiPropertyOptional({
    description:
      'Which order is satisfied first when pay cannot cover them all. ' +
      'Lower goes first; defaults to 100 so unranked orders tie and fall ' +
      'through to the older one.',
    default: 100,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  priority?: number;

  @ApiProperty({ example: '2026-09-01' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'startDate must be YYYY-MM-DD' })
  startDate: string;

  @ApiPropertyOptional({ example: '2027-08-31' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'endDate must be YYYY-MM-DD' })
  endDate?: string | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 2000)
  notes?: string;
}

/**
 * The employee is not changeable: an order names a person, and re-pointing it
 * at somebody else is a different order.
 */
export class UpdateGarnishmentDto extends PartialType(
  OmitType(CreateGarnishmentDto, ['employeeId'] as const),
) {}

export class WaiveCarryForwardDto {
  @ApiProperty({
    description: 'Why the outstanding balance is being written off',
  })
  @IsString()
  @Length(3, 500)
  reason: string;
}

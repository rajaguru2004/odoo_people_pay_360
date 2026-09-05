import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** "HH:MM", 24-hour. Anything else is refused rather than coerced. */
const WALL_CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

export class CreateBranchDto {
  @ApiProperty({ example: 'HQ' })
  @IsString()
  @MaxLength(32)
  code: string;

  @ApiProperty({ example: 'Head Office' })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  // ── Location ───────────────────────────────────────────────────────────────
  @ApiPropertyOptional({ example: 'Building 12, Al Khuwair' })
  @IsOptional()
  @IsString()
  addressLine?: string;

  @ApiPropertyOptional({ example: 'Muscat' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  state?: string;

  @ApiPropertyOptional({ example: 'OM', description: 'ISO-3166 alpha-2' })
  @IsOptional()
  @IsString()
  @MaxLength(2)
  country?: string;

  @ApiPropertyOptional({ example: '112' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  postalCode?: string;

  // ── Identity printed on this branch's documents ────────────────────────────
  @ApiPropertyOptional({ example: '+96824000000' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ description: 'Commercial registration number' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  crNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  vatNumber?: string;

  // ── Working calendar ───────────────────────────────────────────────────────
  @ApiPropertyOptional({
    example: 'Asia/Muscat',
    description: 'Leave unset to inherit the company timezone',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @ApiPropertyOptional({ example: '08:00', description: 'Wall clock, HH:MM' })
  @IsOptional()
  @Matches(WALL_CLOCK, { message: 'officeStartTime must be HH:MM' })
  officeStartTime?: string;

  @ApiPropertyOptional({ example: '17:00', description: 'Wall clock, HH:MM' })
  @IsOptional()
  @Matches(WALL_CLOCK, { message: 'officeEndTime must be HH:MM' })
  officeEndTime?: string;

  @ApiPropertyOptional({
    example: 15,
    description:
      'Minutes after the start time before an arrival counts as late',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(240)
  graceMinutes?: number;

  @ApiPropertyOptional({
    example: [5, 6],
    description:
      'ISO weekday numbers, 1 = Monday. Empty inherits the company calendar.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(7)
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  weeklyOffDays?: number[];

  // ── Geofence ───────────────────────────────────────────────────────────────
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  geofencingEnabled?: boolean;

  @ApiPropertyOptional({ example: 23.588 })
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  latitude?: number;

  @ApiPropertyOptional({ example: 58.3829 })
  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  longitude?: number;

  @ApiPropertyOptional({ example: 150, description: 'Fence radius in metres' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(10)
  @Max(50_000)
  geofenceRadiusM?: number;

  @ApiPropertyOptional({ description: 'Employee who runs this branch' })
  @IsOptional()
  @IsString()
  managerId?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

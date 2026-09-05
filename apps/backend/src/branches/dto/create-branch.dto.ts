import {
  IsString,
  IsOptional,
  IsUUID,
  IsBoolean,
  IsNumber,
  IsInt,
  MaxLength,
  Matches,
  Min,
  Max,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateBranchDto {
  @ApiProperty({ example: 'BLR', description: 'Branch code (unique)', maxLength: 50 })
  @IsString()
  @MaxLength(50)
  code: string;

  @ApiProperty({ example: 'Bangalore Office', description: 'Branch name' })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  // ── Address ──
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  addressLine?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  state?: string;

  @ApiProperty({ required: false, description: 'ISO-3166 alpha-2 country code' })
  @IsOptional()
  @IsString()
  @MaxLength(2)
  country?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  postalCode?: string;

  // ── Per-branch config (null = inherit global) ──
  @ApiProperty({ required: false, description: 'IANA timezone, e.g. Asia/Kolkata' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  timezone?: string;

  @ApiProperty({ required: false, example: '09:30', description: 'HH:MM' })
  @IsOptional()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'officeStartTime must be HH:MM' })
  officeStartTime?: string;

  @ApiProperty({ required: false, example: '18:30', description: 'HH:MM' })
  @IsOptional()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'officeEndTime must be HH:MM' })
  officeEndTime?: string;

  @ApiProperty({
    required: false,
    example: '5,6',
    description:
      'Weekly off days as CSV of day numbers (0=Sun … 6=Sat). Null/omit = inherit company default.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\s*([0-6])(\s*,\s*[0-6])*\s*$|^$/, {
    message: 'weeklyOffDays must be a CSV of day numbers 0-6, e.g. "5,6"',
  })
  // Nullable: the branch form submits null for "inherit the company default",
  // and BranchesService.normalizeWeeklyOffDays() also collapses an empty set to
  // null before the write.
  weeklyOffDays?: string | null;

  // ── Per-branch geofence ──
  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  geofencingEnabled?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude?: number;

  @ApiProperty({ required: false, example: 100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  geofenceRadiusM?: number;

  @ApiProperty({ required: false, description: 'Branch manager (employee ID)' })
  @IsOptional()
  @IsUUID()
  managerId?: string;
}

import {
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * The ESS punch. No employee id: the caller IS the employee, resolved from the
 * principal — accepting one would let anyone punch in for anyone.
 */
export class CheckInDto {
  @ApiPropertyOptional({ example: 23.588, description: 'Device latitude' })
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  latitude?: number;

  @ApiPropertyOptional({ example: 58.3829, description: 'Device longitude' })
  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  longitude?: number;

  @ApiPropertyOptional({ example: 'Client site visit' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

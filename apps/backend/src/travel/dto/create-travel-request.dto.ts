import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const TRAVEL_TYPES = ['DOMESTIC', 'INTERNATIONAL'] as const;
export const ITINERARY_MODES = ['FLIGHT', 'TRAIN', 'ROAD', 'HOTEL', 'OTHER'] as const;

export class TravelItineraryLegDto {
  @ApiProperty({ enum: ITINERARY_MODES })
  @IsIn(ITINERARY_MODES as unknown as string[])
  mode: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  fromPlace?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  toPlace?: string;

  @ApiProperty({ description: 'ISO datetime' })
  @IsDateString()
  startAt: string;

  @ApiPropertyOptional({ description: 'ISO datetime' })
  @IsOptional()
  @IsDateString()
  endAt?: string;

  @ApiPropertyOptional({ description: 'Booking/PNR reference' })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  reference?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class CreateTravelRequestDto {
  @ApiProperty()
  @IsString()
  purpose: string;

  @ApiProperty({ enum: TRAVEL_TYPES })
  @IsIn(TRAVEL_TYPES as unknown as string[])
  travelType: string;

  @ApiProperty({ description: 'PER_DIEM_DESTINATION library label' })
  @IsString()
  @MaxLength(200)
  destination: string;

  @ApiPropertyOptional({ description: 'Required for INTERNATIONAL to drive the visa check' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  country?: string;

  @ApiProperty({ example: '2026-09-01' })
  @IsDateString()
  departureDate: string;

  @ApiProperty({ example: '2026-09-05' })
  @IsDateString()
  returnDate: string;

  @ApiPropertyOptional({
    description: 'Defaults to the inclusive day count of the trip',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  perDiemDays?: number;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  estimatedCost: number;

  @ApiPropertyOptional({
    description: 'Cash advance requested for the trip',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  advanceAmount?: number;

  @ApiPropertyOptional({ type: [TravelItineraryLegDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => TravelItineraryLegDto)
  itinerary?: TravelItineraryLegDto[];
}

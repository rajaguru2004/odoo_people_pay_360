import {
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateSessionDto {
  @ApiProperty()
  @IsUUID()
  courseId: string;

  @ApiPropertyOptional({ description: 'Omit to open the session to every branch' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiProperty({ example: '2026-10-05' })
  @IsDateString()
  startDate: string;

  @ApiProperty({ example: '2026-10-07' })
  @IsDateString()
  endDate: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  location?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  trainer?: string;

  @ApiPropertyOptional({ description: 'Seat cap; omit for unlimited' })
  @IsOptional()
  @IsInt()
  @Min(1)
  seats?: number;

  @ApiPropertyOptional({ description: "Defaults to the course's default cost" })
  @IsOptional()
  @IsNumber()
  @Min(0)
  costPerSeat?: number;
}

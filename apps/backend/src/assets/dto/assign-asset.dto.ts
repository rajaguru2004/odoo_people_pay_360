import {
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AssignAssetDto {
  @ApiProperty()
  @IsUUID()
  assetId: string;

  @ApiProperty()
  @IsUUID()
  employeeId: string;

  @ApiPropertyOptional({ description: 'Defaults to today' })
  @IsOptional()
  @IsDateString()
  assignedAt?: string;

  @ApiPropertyOptional({
    example: 'New',
    description: 'Condition at hand-over',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  conditionOut?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

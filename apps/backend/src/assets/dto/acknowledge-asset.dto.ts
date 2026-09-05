import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class AcknowledgeAssetDto {
  @ApiPropertyOptional({ description: 'Optional note from the employee' })
  @IsOptional()
  @IsString()
  note?: string;
}

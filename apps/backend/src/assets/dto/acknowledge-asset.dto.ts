import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class AcknowledgeAssetDto {
  @ApiPropertyOptional({ description: 'The holder’s own note on receipt' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

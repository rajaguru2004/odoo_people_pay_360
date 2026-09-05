import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class DecideTravelDto {
  @ApiPropertyOptional({ description: 'Approver comment / rejection reason' })
  @IsOptional()
  @IsString()
  remarks?: string;
}

import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class DecideNominationDto {
  @ApiPropertyOptional({
    description: 'Approver comment, or the reason for a refusal',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remarks?: string;
}

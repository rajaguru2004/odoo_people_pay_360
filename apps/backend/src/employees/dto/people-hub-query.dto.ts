import { IsInt, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class PeopleHubQueryDto {
  @ApiPropertyOptional({
    enum: [6, 12],
    default: 12,
    description: 'Length of the movement trend window',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  months?: number;
}

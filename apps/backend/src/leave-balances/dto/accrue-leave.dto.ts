import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class AccrueLeaveDto {
  @ApiProperty({
    example: 2,
    description:
      'Days to credit. Whole days: the balance columns are integers.',
  })
  @IsInt()
  @Min(1)
  daysToAdd: number;

  @ApiPropertyOptional({ example: 'Long-service award' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

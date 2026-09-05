import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Min } from 'class-validator';

export class UpdateTypeBalanceDto {
  @ApiProperty({ example: 30, description: 'Days allocated for this year' })
  @IsInt()
  @Min(0)
  allocated: number;

  @ApiPropertyOptional({
    example: 5,
    description:
      'Days brought forward from last year. Counted towards the remaining balance alongside the allocation.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  carriedOver?: number;
}

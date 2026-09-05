import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class ListHolidaysDto {
  @ApiPropertyOptional({ example: 2026 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1970)
  @Max(2200)
  year?: number;

  @ApiPropertyOptional({
    description:
      "Returns company-wide holidays plus this branch's, the branch row winning on a shared date",
  })
  @IsOptional()
  @IsUUID()
  branchId?: string;
}

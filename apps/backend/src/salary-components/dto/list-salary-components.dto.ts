import { IsBooleanString, IsEnum, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { SalaryComponentType } from '@prisma/client';

export class ListSalaryComponentsDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  page?: number;

  @ApiPropertyOptional({ default: 20, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  limit?: number;

  @ApiPropertyOptional({ enum: SalaryComponentType })
  @IsOptional()
  @IsEnum(SalaryComponentType)
  type?: SalaryComponentType;

  @ApiPropertyOptional({ description: "'true' or 'false'" })
  @IsOptional()
  @IsBooleanString()
  isActive?: string;

  @ApiPropertyOptional({ description: 'Matches code or name' })
  @IsOptional()
  @IsString()
  search?: string;
}

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

/** Optional overrides to test unsaved form values; each falls back to stored config. */
export class TestConnectionDto {
  @ApiPropertyOptional() @IsOptional() @IsString() baseUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() apiKey?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() model?: string;
}

import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LETTER_LOCALES } from './request-letter.dto';

export class UpsertLetterTemplateDto {
  @ApiProperty({ example: 'SALARY_CERTIFICATE' })
  @IsString()
  @MaxLength(50)
  key: string;

  @ApiProperty({ example: 'Salary Certificate' })
  @IsString()
  @MaxLength(200)
  name: string;

  @ApiPropertyOptional({ enum: LETTER_LOCALES, default: 'en' })
  @IsOptional()
  @IsIn(LETTER_LOCALES)
  locale?: string;

  @ApiProperty({
    description:
      'The letter body. Supports {{value}} and {{#if value}}…{{else}}…{{/if}} against a ' +
      'fixed context — see letter-template.util.ts. Must be self-contained markup.',
  })
  @IsString()
  bodyHtml: string;

  @ApiPropertyOptional({
    default: true,
    description:
      'false issues on request; keep it true for anything stating pay',
  })
  @IsOptional()
  @IsBoolean()
  requiresApproval?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

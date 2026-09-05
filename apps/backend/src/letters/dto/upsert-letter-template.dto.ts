import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
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
  @IsIn(LETTER_LOCALES as unknown as string[])
  locale?: string;

  @ApiProperty({
    description:
      'Handlebars source rendered to PDF. Must be a self-contained document — a strict no-network page means external stylesheets and webfonts will not load.',
  })
  @IsString()
  bodyHtml: string;

  @ApiPropertyOptional({
    default: true,
    description: 'false issues instantly; keep true for anything stating pay',
  })
  @IsOptional()
  @IsBoolean()
  requiresApproval?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

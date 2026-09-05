import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const LETTER_LOCALES = ['en', 'ar'] as const;

export class RequestLetterDto {
  @ApiProperty({
    example: 'SALARY_CERTIFICATE',
    description:
      'A LetterTemplate key: SALARY_CERTIFICATE | NOC | EXPERIENCE | EMBASSY',
  })
  @IsString()
  @MaxLength(50)
  templateKey: string;

  @ApiPropertyOptional({ enum: LETTER_LOCALES, default: 'en' })
  @IsOptional()
  @IsIn(LETTER_LOCALES)
  locale?: string;

  @ApiPropertyOptional({
    description: 'Why the letter is needed; it appears in the text',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  purpose?: string;

  @ApiPropertyOptional({ example: 'Bank Muscat', description: 'The addressee' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  addressedTo?: string;
}

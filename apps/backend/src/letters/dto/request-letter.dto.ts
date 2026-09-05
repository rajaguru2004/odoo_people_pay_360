import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const LETTER_LOCALES = ['en', 'ar'] as const;

export class RequestLetterDto {
  @ApiProperty({
    example: 'SALARY_CERTIFICATE',
    description: 'LetterTemplate key: SALARY_CERTIFICATE | NOC | EXPERIENCE | EMBASSY',
  })
  @IsString()
  @MaxLength(50)
  templateKey: string;

  @ApiPropertyOptional({ enum: LETTER_LOCALES, default: 'en' })
  @IsOptional()
  @IsIn(LETTER_LOCALES as unknown as string[])
  locale?: string;

  @ApiPropertyOptional({ description: 'Why the letter is needed; appears in the text' })
  @IsOptional()
  @IsString()
  purpose?: string;

  @ApiPropertyOptional({ example: 'Bank Muscat', description: 'Addressee' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  addressedTo?: string;
}

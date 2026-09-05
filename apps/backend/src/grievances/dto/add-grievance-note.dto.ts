import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AddGrievanceNoteDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  note: string;

  @ApiPropertyOptional({
    default: false,
    description: 'An internal note is never shown to the complainant',
  })
  @IsOptional()
  @IsBoolean()
  isInternal?: boolean;
}

import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AddGrievanceNoteDto {
  @ApiProperty()
  @IsString()
  note: string;

  @ApiPropertyOptional({
    default: false,
    description: 'Internal notes are never shown to the complainant',
  })
  @IsOptional()
  @IsBoolean()
  isInternal?: boolean;
}

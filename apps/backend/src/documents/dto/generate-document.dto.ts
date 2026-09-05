import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class GenerateDocumentDto {
  @ApiProperty({ description: 'A key from GET /documents/types.' })
  @IsString()
  @MaxLength(50)
  typeKey!: string;

  @ApiPropertyOptional({ description: 'Template locale. Falls back to English when absent.' })
  @IsOptional()
  @IsString()
  @MaxLength(5)
  locale?: string;

  @ApiPropertyOptional({ description: 'Whom the document is about.' })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional({ description: 'The record it describes: a payroll item, a settlement.' })
  @IsOptional()
  @IsUUID()
  subjectId?: string;

  @ApiPropertyOptional({ description: 'month, year, dateFrom, dateTo … interpreted by the type.' })
  @IsOptional()
  @IsObject()
  params?: Record<string, unknown>;
}

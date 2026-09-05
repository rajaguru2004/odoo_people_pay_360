import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LegalDocumentCategory, LegalDocumentStatus } from '@prisma/client';

export class CreateLegalDocumentDto {
  @ApiProperty()
  @IsUUID()
  employeeId: string;

  @ApiPropertyOptional({
    enum: LegalDocumentCategory,
    default: LegalDocumentCategory.VISA,
  })
  @IsOptional()
  @IsEnum(LegalDocumentCategory)
  category?: LegalDocumentCategory;

  @ApiPropertyOptional({
    enum: LegalDocumentStatus,
    default: LegalDocumentStatus.ACTIVE,
  })
  @IsOptional()
  @IsEnum(LegalDocumentStatus)
  status?: LegalDocumentStatus;

  @ApiProperty({ example: 'V-2026-884213' })
  @IsString()
  @MaxLength(100)
  documentNumber: string;

  @ApiPropertyOptional({ example: 'Employment visa' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  documentType?: string;

  @ApiProperty({ example: 'Oman' })
  @IsString()
  @MaxLength(100)
  country: string;

  @ApiPropertyOptional({ example: 'IN', description: 'ISO-3166 alpha-2' })
  @IsOptional()
  @IsString()
  @Length(2, 2)
  nationality?: string;

  @ApiProperty({ example: '2026-01-10' })
  @IsDateString()
  issueDate: string;

  @ApiProperty({ example: '2028-01-09' })
  @IsDateString()
  expiryDate: string;

  @ApiPropertyOptional({ example: 'Royal Oman Police' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  issuingAuthority?: string;

  @ApiPropertyOptional({ example: 'Muscat' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  placeOfIssue?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  sponsor?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  remarks?: string;

  @ApiPropertyOptional({
    default: true,
    description: 'Only one current document per employee and category',
  })
  @IsOptional()
  @IsBoolean()
  isCurrent?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(512)
  documentUrl?: string;
}

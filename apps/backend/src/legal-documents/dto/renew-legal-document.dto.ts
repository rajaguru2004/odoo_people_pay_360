import {
  IsDateString,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * The replacement document. Anything left out is carried over from the row
 * being renewed — a renewal that only moves the dates should not have to
 * restate the sponsor and the issuing authority.
 */
export class RenewLegalDocumentDto {
  @ApiPropertyOptional({ example: 'V-2028-119045' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  documentNumber?: string;

  @ApiProperty({ example: '2028-01-10' })
  @IsDateString()
  issueDate: string;

  @ApiProperty({ example: '2030-01-09' })
  @IsDateString()
  expiryDate: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  documentType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  country?: string;

  @ApiPropertyOptional({ description: 'ISO-3166 alpha-2' })
  @IsOptional()
  @IsString()
  @Length(2, 2)
  nationality?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  issuingAuthority?: string;

  @ApiPropertyOptional()
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

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(512)
  documentUrl?: string;
}

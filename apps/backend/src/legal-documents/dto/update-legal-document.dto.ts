import {
  IsString,
  IsDateString,
  IsOptional,
  IsISO31661Alpha2,
  MaxLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

// Correction edit — NOT a renewal. Renewals go through RenewLegalDocumentDto
// so that history is preserved as a separate record.
export class UpdateLegalDocumentDto {
  @ApiProperty({ example: 'V-1234567', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  documentNumber?: string;

  @ApiProperty({ example: 'Employment Visa', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  documentType?: string;

  @ApiProperty({ example: 'United Arab Emirates', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  country?: string;

  @ApiProperty({
    example: 'IN',
    required: false,
    description: "Employee's nationality (ISO-3166 alpha-2 code)",
  })
  @IsOptional()
  @IsISO31661Alpha2()
  nationality?: string;

  @ApiProperty({ example: '2026-01-01', required: false })
  @IsOptional()
  @IsDateString()
  issueDate?: string;

  @ApiProperty({ example: '2028-01-01', required: false })
  @IsOptional()
  @IsDateString()
  expiryDate?: string;

  @ApiProperty({ example: 'GDRFA Dubai', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  issuingAuthority?: string;

  @ApiProperty({ example: 'Dubai', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  placeOfIssue?: string;

  @ApiProperty({ example: 'Acme LLC', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  sponsor?: string;

  @ApiProperty({ example: 'Multiple entry', required: false })
  @IsOptional()
  @IsString()
  remarks?: string;
}

// Renewal: creates a NEW record linked via renewedFromId; old record becomes
// status=RENEWED, isCurrent=false. Category/country/type carry over unless overridden.
export class RenewLegalDocumentDto {
  @ApiProperty({ example: 'V-7654321', description: 'New visa/document number' })
  @IsString()
  @MaxLength(100)
  documentNumber: string;

  @ApiProperty({ example: '2028-01-02', description: 'New issue date' })
  @IsDateString()
  issueDate: string;

  @ApiProperty({ example: '2030-01-01', description: 'New expiry date' })
  @IsDateString()
  expiryDate: string;

  @ApiProperty({ example: 'Employment Visa', required: false, description: 'Override document type' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  documentType?: string;

  @ApiProperty({ example: 'GDRFA Dubai', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  issuingAuthority?: string;

  @ApiProperty({ example: 'Dubai', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  placeOfIssue?: string;

  @ApiProperty({ example: 'Acme LLC', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  sponsor?: string;

  @ApiProperty({ example: 'Renewed for 2 years', required: false })
  @IsOptional()
  @IsString()
  remarks?: string;
}

export class CancelLegalDocumentDto {
  @ApiProperty({ example: 'Visa revoked by authority', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

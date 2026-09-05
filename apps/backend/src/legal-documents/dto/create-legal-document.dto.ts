import {
  IsString,
  IsDateString,
  IsOptional,
  IsUUID,
  IsEnum,
  IsISO31661Alpha2,
  MaxLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { LegalDocumentCategoryValue } from '../legal-document.constants';

export class CreateLegalDocumentDto {
  @ApiProperty({
    example: '11111111-1111-1111-1111-111111111111',
    description: 'Employee ID',
  })
  @IsUUID()
  employeeId: string;

  @ApiProperty({
    example: 'VISA',
    enum: LegalDocumentCategoryValue,
    required: false,
    description: 'Document category (defaults to VISA)',
  })
  @IsOptional()
  @IsEnum(LegalDocumentCategoryValue)
  category?: string;

  @ApiProperty({ example: 'V-1234567', description: 'Visa/document number' })
  @IsString()
  @MaxLength(100)
  documentNumber: string;

  @ApiProperty({
    example: 'Employment Visa',
    description: 'Document type (VISA_TYPE library item label)',
  })
  @IsString()
  @MaxLength(100)
  documentType: string;

  @ApiProperty({ example: 'United Arab Emirates', description: 'Issuing country' })
  @IsString()
  @MaxLength(100)
  country: string;

  @ApiProperty({
    example: 'IN',
    required: false,
    description: "Employee's nationality (ISO-3166 alpha-2 code)",
  })
  @IsOptional()
  @IsISO31661Alpha2()
  nationality?: string;

  @ApiProperty({ example: '2026-01-01', description: 'Issue date' })
  @IsDateString()
  issueDate: string;

  @ApiProperty({ example: '2028-01-01', description: 'Expiry date' })
  @IsDateString()
  expiryDate: string;

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

  @ApiProperty({ example: 'Acme LLC', required: false, description: 'Sponsor (Gulf region)' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  sponsor?: string;

  @ApiProperty({ example: 'Multiple entry', required: false })
  @IsOptional()
  @IsString()
  remarks?: string;
}

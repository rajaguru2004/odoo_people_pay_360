import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { LegalDocumentCategory, LegalDocumentStatus } from '@prisma/client';

export class ListLegalDocumentsDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  page?: number;

  @ApiPropertyOptional({ default: 20, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  limit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional({ enum: LegalDocumentCategory })
  @IsOptional()
  @IsEnum(LegalDocumentCategory)
  category?: LegalDocumentCategory;

  @ApiPropertyOptional({ enum: LegalDocumentStatus })
  @IsOptional()
  @IsEnum(LegalDocumentStatus)
  status?: LegalDocumentStatus;

  @ApiPropertyOptional({
    description: 'Matches document number, employee code, first or last name',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ example: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expiringWithinDays?: number;

  @ApiPropertyOptional({
    default: true,
    description: 'Superseded documents are hidden unless this is turned off',
  })
  @IsOptional()
  // Query strings carry `false`, not a boolean, and a non-empty string is
  // truthy — without the transform the flag could never be turned off.
  @Transform(({ value }) => value !== false && value !== 'false')
  currentOnly?: boolean;
}

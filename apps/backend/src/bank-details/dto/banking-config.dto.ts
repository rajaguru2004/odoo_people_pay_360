import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpsertBankingFieldDto {
  @ApiProperty({ description: 'ISO-2 country code' })
  @IsString()
  @Length(2, 2)
  country: string;

  @ApiProperty({ description: 'Internal key, e.g. "iban", "ifsc"' })
  @IsString()
  @Length(1, 50)
  fieldKey: string;

  @ApiProperty()
  @IsString()
  @Length(1, 100)
  label: string;

  @ApiPropertyOptional({ enum: ['TEXT', 'NUMBER', 'SELECT'] })
  @IsOptional()
  @IsString()
  fieldType?: string;

  @ApiProperty({
    enum: ['NONE', 'IBAN', 'IFSC', 'SWIFT', 'SORT_CODE', 'ROUTING', 'NUMBER', 'REGEX'],
  })
  @IsString()
  validationType: string;

  @ApiPropertyOptional({ description: 'Pattern when validationType = REGEX' })
  @IsOptional()
  @IsString()
  regex?: string;

  @ApiPropertyOptional({ description: 'Choices when fieldType = SELECT' })
  @IsOptional()
  @IsObject()
  options?: Record<string, unknown>;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  displayOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 255)
  placeholder?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 255)
  helpText?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isSensitive?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

import {
  IsBoolean,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateBankDto {
  @ApiProperty({ description: 'ISO-2 country code, e.g. "OM"' })
  @IsString()
  @Length(2, 2)
  @Matches(/^[A-Za-z]{2}$/, { message: 'country must be a 2-letter ISO code' })
  country: string;

  @ApiProperty()
  @IsString()
  @Length(1, 255)
  name: string;

  @ApiPropertyOptional({ description: 'In-IBAN bank code (OM: 3-char CBO code)' })
  @IsOptional()
  @IsString()
  @Length(1, 20)
  bankCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(8, 11)
  swift?: string;
}

export class UpdateBankDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 255)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 20)
  bankCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(8, 11)
  swift?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

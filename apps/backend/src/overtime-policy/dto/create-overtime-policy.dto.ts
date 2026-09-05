import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { OvertimePolicyRulesDto } from './overtime-policy-rules.dto';

export class CreateOvertimePolicyDto {
  @ApiProperty({ example: 'Daily Wage OT' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  name: string;

  @ApiPropertyOptional({ example: 'Overtime rules for daily-wage staff' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    default: false,
    description:
      'Make this the company-wide default, unsetting the previous one',
  })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiPropertyOptional({
    description:
      'The EMPLOYMENT_TYPE library label this policy targets — the middle ' +
      'inheritance tier. Omit for a default or unscoped policy.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  employmentType?: string;

  @ApiPropertyOptional({ type: OvertimePolicyRulesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => OvertimePolicyRulesDto)
  rules?: OvertimePolicyRulesDto;
}

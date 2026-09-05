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
      'Mark as the company-wide default policy (unsets the previous)',
  })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiPropertyOptional({
    description:
      'Employment type this policy targets: the middle tier of the inheritance chain, matched against the contract type on the employee record (for example "PART_TIME"). Omit for a policy that is not scoped to one.',
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

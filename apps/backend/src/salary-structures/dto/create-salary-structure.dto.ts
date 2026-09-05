import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * One line of the structure: a catalogue component and the fixed amount it
 * pays. There is no percentage-of-basic form — the engine reads amounts, and a
 * rule the engine cannot read is a rule that quietly does nothing.
 */
export class SalaryStructureLineDto {
  @ApiProperty({
    description: 'A SalaryComponent id, which must still be active',
  })
  @IsUUID()
  componentId: string;

  @ApiProperty({ example: 750.5, description: 'Three decimal places' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  amount: number;
}

export class CreateSalaryStructureDto {
  @ApiProperty()
  @IsUUID()
  employeeId: string;

  @ApiPropertyOptional({
    example: 'OMR',
    default: 'OMR',
    description:
      "Must match the currency of the employee's active contract when they have one",
  })
  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  @ApiProperty({
    example: '2026-01-01',
    description: 'Date only, never an instant',
  })
  @IsDateString()
  effectiveFrom: string;

  @ApiProperty({ type: [SalaryStructureLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SalaryStructureLineDto)
  lines: SalaryStructureLineDto[];
}

import {
  IsString,
  IsDateString,
  IsUUID,
  IsNumber,
  Min,
  IsEnum,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateDisciplineDto {
  @ApiProperty({ example: '11111111-1111-1111-1111-111111111111' })
  @IsUUID()
  employeeId: string;

  @ApiProperty({ example: 'Violation of company rules' })
  @IsString()
  reason: string;

  @ApiProperty({
    example: 'WARNING',
    enum: ['WARNING', 'FINE', 'DEMOTION', 'TERMINATION'],
  })
  @IsEnum(['WARNING', 'FINE', 'DEMOTION', 'TERMINATION'])
  disciplineType: string;

  @ApiProperty({
    example: 500000,
    description: 'Fine amount (VND)',
    default: 0,
  })
  @IsNumber()
  @Min(0)
  amount: number;

  @ApiProperty({ example: '2026-01-15' })
  @IsDateString()
  disciplineDate: string;
}

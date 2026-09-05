import { ApiProperty } from '@nestjs/swagger';
import {
  IsDateString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateReimbursementDto {
  @ApiProperty({ example: 'Travel', description: 'Reimbursement type' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  type: string;

  @ApiProperty({ example: 2500, description: 'Reimbursement amount' })
  @IsNumber()
  @IsPositive()
  amount: number;

  @ApiProperty({ example: '2026-07-01', description: 'Date of the expense' })
  @IsDateString()
  @IsNotEmpty()
  expenseDate: string;

  @ApiProperty({
    example: 'Client visit cab fare',
    description: 'Expense description',
    required: false,
  })
  @IsOptional()
  @IsString()
  description?: string;
}

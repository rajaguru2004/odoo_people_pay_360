import { IsString, IsNotEmpty, IsOptional, IsArray } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateBatchDto {
  @ApiProperty({ example: 'Engineering Batch', description: 'Name of the payroll batch' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 'All engineering team members', required: false, description: 'Description of the batch' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ example: ['employee-uuid-1', 'employee-uuid-2'], description: 'Employee IDs in the batch' })
  @IsArray()
  @IsString({ each: true })
  employeeIds: string[];
}

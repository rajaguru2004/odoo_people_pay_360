import { IsArray, IsString, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class BulkApproveDto {
  @ApiProperty({
    description: 'Array of payroll IDs to approve',
    example: ['uuid-1', 'uuid-2', 'uuid-3'],
  })
  @IsArray()
  @IsString({ each: true })
  payrollIds: string[];

  @ApiProperty({
    description: 'Optional approval notes',
    required: false,
  })
  @IsOptional()
  @IsString()
  notes?: string;
}

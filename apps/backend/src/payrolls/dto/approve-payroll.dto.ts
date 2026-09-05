import { IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ApprovePayrollDto {
  @ApiProperty({
    description: 'Optional approval notes',
    required: false,
  })
  @IsOptional()
  @IsString()
  notes?: string;
}

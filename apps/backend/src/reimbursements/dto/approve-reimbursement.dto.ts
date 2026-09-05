import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class ApproveReimbursementDto {
  @ApiProperty({
    example: 'Verified against attached invoice',
    description: 'Approval remarks',
    required: false,
  })
  @IsOptional()
  @IsString()
  remarks?: string;
}

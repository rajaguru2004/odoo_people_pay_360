import { IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RejectPayrollDto {
  @ApiProperty({
    description: 'Reason for rejection (required)',
    example:
      'There is an error in employee A salary calculation. Please check again.',
  })
  @IsNotEmpty({ message: 'Rejection reason cannot be empty' })
  @IsString()
  reason: string;
}

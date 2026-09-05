import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class RejectOvertimeDto {
  @ApiProperty({
    example: 'No prior request from the project manager',
    description: 'Reason for the rejection',
  })
  @IsString()
  @IsNotEmpty()
  rejectedReason: string;
}

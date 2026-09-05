import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class RejectOvertimeDto {
  @ApiProperty({
    example: 'No request from project manager',
    description: 'Reason for rejection',
  })
  @IsString()
  @IsNotEmpty()
  rejectedReason: string;
}

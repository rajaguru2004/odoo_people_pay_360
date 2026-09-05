import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class RejectReimbursementDto {
  @ApiProperty({
    example: 'Invoice does not match the claimed amount',
    description: 'Reason for rejection',
  })
  @IsString()
  @IsNotEmpty()
  remarks: string;
}

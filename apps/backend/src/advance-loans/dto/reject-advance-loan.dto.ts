import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class RejectAdvanceLoanDto {
  @ApiProperty({
    example: 'Outstanding advance already active',
    description: 'Reason for rejection',
  })
  @IsString()
  @IsNotEmpty()
  remarks: string;
}

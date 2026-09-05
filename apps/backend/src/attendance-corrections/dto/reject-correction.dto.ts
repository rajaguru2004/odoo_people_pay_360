import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class RejectAttendanceCorrectionDto {
  @ApiProperty({
    example: 'No verification evidence',
    description: 'Reason for rejection',
  })
  @IsString()
  @IsNotEmpty()
  rejectedReason: string;
}

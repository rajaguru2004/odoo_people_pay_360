import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class RejectOvertimeDto {
  @ApiProperty({
    example: 'No prior authorisation from the project manager',
    description:
      'Required. "Rejected" on its own is the start of an argument, not the end of one.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  rejectedReason: string;
}

import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class RejectLeaveRequestDto {
  @ApiProperty({
    example: 'Two people are already off that week',
    description:
      'Required on a rejection and only there. The person who filed it is owed a reason.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  comment: string;
}

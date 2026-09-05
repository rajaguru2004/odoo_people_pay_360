import { IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateRevisionDto {
  @ApiProperty({
    description: 'Reason for creating revision',
    example:
      'Need to adjust employee B salary due to incorrect overtime calculation',
  })
  @IsNotEmpty({ message: 'Reason for creating a new version cannot be empty' })
  @IsString()
  reason: string;
}

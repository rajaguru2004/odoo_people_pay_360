import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class SetPolicyActiveDto {
  @ApiProperty({ example: false })
  @IsBoolean()
  isActive: boolean;
}

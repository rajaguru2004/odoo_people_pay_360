import { IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ChangePasswordDto {
  @ApiProperty({ example: 'Admin@123' })
  @IsString()
  oldPassword: string;

  @ApiProperty({ example: 'N3w@Password', minLength: 8 })
  @IsString()
  @MinLength(8)
  newPassword: string;
}

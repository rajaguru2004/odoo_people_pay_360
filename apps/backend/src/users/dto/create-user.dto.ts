import {
  IsEmail,
  IsString,
  MinLength,
  IsEnum,
  IsOptional,
  IsUUID,
  IsBoolean,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateUserDto {
  @ApiProperty({
    example: 'user@company.com',
    description: 'User email address',
  })
  @IsEmail()
  email: string;

  @ApiProperty({
    example: 'Password@123',
    description: 'User password',
    minLength: 6,
  })
  @IsString()
  @MinLength(6)
  password: string;

  @ApiProperty({
    example: 'EMPLOYEE',
    enum: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
  })
  @IsEnum(['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'])
  role: string;

  @ApiProperty({
    example: '11111111-1111-1111-1111-111111111111',
    required: false,
  })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiProperty({ example: true, required: false, default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

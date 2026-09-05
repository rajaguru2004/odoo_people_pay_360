import {
  IsEmail,
  IsString,
  MinLength,
  IsEnum,
  IsOptional,
  IsUUID,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RegisterDto {
  @ApiProperty({
    example: 'user@company.com',
    description: 'User email address',
  })
  @IsEmail()
  email: string;

  @ApiProperty({
    example: 'Password@123',
    description: 'User password (minimum 6 characters)',
    minLength: 6,
  })
  @IsString()
  @MinLength(6)
  password: string;

  @ApiProperty({
    example: 'EMPLOYEE',
    description: 'User role',
    enum: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
  })
  @IsEnum(['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'])
  role: string;

  @ApiProperty({
    example: '11111111-1111-1111-1111-111111111111',
    description: 'Employee ID to link with user account',
    required: false,
  })
  @IsOptional()
  @IsUUID()
  employeeId?: string;
}

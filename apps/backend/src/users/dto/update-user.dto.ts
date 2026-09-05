import {
  IsEmail,
  IsString,
  IsEnum,
  IsOptional,
  IsUUID,
  IsBoolean,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateUserDto {
  @ApiProperty({ example: 'user@company.com', required: false })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({
    example: 'EMPLOYEE',
    enum: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
    required: false,
  })
  @IsOptional()
  @IsEnum(['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'])
  role?: string;

  @ApiProperty({
    example: '11111111-1111-1111-1111-111111111111',
    required: false,
  })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiProperty({ example: true, required: false })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

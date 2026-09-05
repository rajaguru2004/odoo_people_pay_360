import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';

export class RegisterDto {
  @ApiProperty({ example: 'payroll@peoplepay360.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'Str0ng@Pass', minLength: 8 })
  @IsString()
  @MinLength(8)
  password: string;

  @ApiProperty({ enum: UserRole, example: UserRole.EMPLOYEE })
  @IsEnum(UserRole)
  role: UserRole;

  @ApiPropertyOptional({ description: 'Employee record to link this login to' })
  @IsOptional()
  @IsUUID()
  employeeId?: string;
}

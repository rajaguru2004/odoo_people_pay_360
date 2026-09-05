import {
  IsDateString,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EmployeeStatus } from '@prisma/client';

export class CreateEmployeeDto {
  @ApiProperty({ example: 'EMP-0001' })
  @IsString()
  @MaxLength(32)
  employeeCode: string;

  @ApiProperty({ example: 'Aisha' })
  @IsString()
  @MaxLength(120)
  firstName: string;

  @ApiProperty({ example: 'Al Balushi' })
  @IsString()
  @MaxLength(120)
  lastName: string;

  @ApiPropertyOptional({ example: 'aisha@peoplepay360.com' })
  @IsOptional()
  @IsEmail()
  workEmail?: string;

  @ApiPropertyOptional({ example: '+96890000000' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  @ApiPropertyOptional({ example: 'Payroll Analyst' })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  position?: string;

  @ApiPropertyOptional({ enum: EmployeeStatus, default: EmployeeStatus.ACTIVE })
  @IsOptional()
  @IsEnum(EmployeeStatus)
  status?: EmployeeStatus;

  @ApiPropertyOptional({ example: '2026-01-15' })
  @IsOptional()
  @IsDateString()
  hireDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiPropertyOptional({ description: 'Line manager' })
  @IsOptional()
  @IsUUID()
  managerId?: string;

  @ApiPropertyOptional({
    example: 'Asia/Muscat',
    description: 'Leave unset to inherit the company timezone',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;
}

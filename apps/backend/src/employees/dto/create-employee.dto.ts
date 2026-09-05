import {
  IsDateString,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Length,
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

  @ApiPropertyOptional({
    example: 'aisha@example.com',
    description: 'Reachable after the work account is closed',
  })
  @IsOptional()
  @IsEmail()
  personalEmail?: string;

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

  @ApiPropertyOptional({
    example: '2027-03-31',
    description: 'Last working day. Set by the termination flow, not by hand.',
  })
  @IsOptional()
  @IsDateString()
  exitDate?: string;

  @ApiPropertyOptional({ example: '1994-07-02' })
  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;

  @ApiPropertyOptional({ example: 'Female' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  gender?: string;

  @ApiPropertyOptional({ example: 'OM', description: 'ISO-3166 alpha-2' })
  @IsOptional()
  @IsString()
  @Length(2, 2)
  nationality?: string;

  @ApiPropertyOptional({
    example: '12345678',
    description: 'Civil or national id. Unique across the workforce.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  nationalId?: string;

  @ApiPropertyOptional({ example: 'Way 3021, Al Khuwair, Muscat' })
  @IsOptional()
  @IsString()
  address?: string;

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
    description:
      'Who signs this person off. Often the line manager, deliberately not always.',
  })
  @IsOptional()
  @IsUUID()
  supervisorId?: string;

  @ApiPropertyOptional({
    example: 'Asia/Muscat',
    description: 'Leave unset to inherit the company timezone',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;
}

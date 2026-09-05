import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { EmployeeStatus } from '@prisma/client';

/** Columns the directory is allowed to sort on, kept as an allow-list so a
 * query string cannot reach an unindexed column or a relation. */
export enum EmployeeSortBy {
  EMPLOYEE_CODE = 'employeeCode',
  FIRST_NAME = 'firstName',
  HIRE_DATE = 'hireDate',
  STATUS = 'status',
}

export enum SortOrder {
  ASC = 'asc',
  DESC = 'desc',
}

export class ListEmployeesDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  page?: number;

  @ApiPropertyOptional({ default: 20, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  limit?: number;

  @ApiPropertyOptional({
    description: 'Matches code, first name, last name or work email',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ enum: EmployeeStatus })
  @IsOptional()
  @IsEnum(EmployeeStatus)
  status?: EmployeeStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ description: 'Direct reports of this line manager' })
  @IsOptional()
  @IsUUID()
  managerId?: string;

  @ApiPropertyOptional({ description: 'People this person signs off' })
  @IsOptional()
  @IsUUID()
  supervisorId?: string;

  @ApiPropertyOptional({
    enum: EmployeeSortBy,
    default: EmployeeSortBy.EMPLOYEE_CODE,
  })
  @IsOptional()
  @IsEnum(EmployeeSortBy)
  sortBy?: EmployeeSortBy;

  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.ASC })
  @IsOptional()
  @IsEnum(SortOrder)
  sortOrder?: SortOrder;
}

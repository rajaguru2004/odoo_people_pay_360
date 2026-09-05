import {
  IsOptional,
  IsString,
  IsEnum,
  IsInt,
  Min,
  Max,
  IsUUID,
  IsArray,
  IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Columns the employee list may be sorted by. Kept narrow and explicit because
 * the value reaches Prisma's `orderBy` as a key: anything not listed here is a
 * driver error, so it is rejected at the pipe with a 400 instead.
 */
export const EMPLOYEE_SORT_FIELDS = [
  'employeeCode',
  'fullName',
  'email',
  'position',
  'status',
  'gender',
  'startDate',
  'baseSalary',
  'createdAt',
  'updatedAt',
] as const;
export type EmployeeSortField = (typeof EMPLOYEE_SORT_FIELDS)[number];

export class QueryEmployeesDto {
  @ApiProperty({
    example: 'John',
    required: false,
    description: 'Search by name, email, or employee code',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiProperty({
    example: '11111111-1111-1111-1111-111111111111',
    required: false,
  })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiProperty({
    type: [String],
    required: false,
    description:
      'Restrict results to these departments. Used to scope a MANAGER to every department they manage.',
  })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  departmentIds?: string[];

  @ApiProperty({ example: 'Software Engineer', required: false })
  @IsOptional()
  @IsString()
  position?: string;

  @ApiProperty({
    example: 'ACTIVE',
    enum: ['ACTIVE', 'INACTIVE', 'ON_LEAVE', 'TERMINATED'],
    required: false,
  })
  @IsOptional()
  @IsEnum(['ACTIVE', 'INACTIVE', 'ON_LEAVE', 'TERMINATED'])
  status?: string;

  @ApiProperty({
    example: 'MALE',
    enum: ['MALE', 'FEMALE', 'OTHER'],
    required: false,
  })
  @IsOptional()
  @IsEnum(['MALE', 'FEMALE', 'OTHER'])
  gender?: string;

  @ApiProperty({ example: 1, required: false, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiProperty({ example: 10, required: false, default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number = 10;

  @ApiProperty({
    example: 'fullName',
    required: false,
    enum: EMPLOYEE_SORT_FIELDS,
    description: `Sort field. One of: ${EMPLOYEE_SORT_FIELDS.join(', ')}.`,
  })
  @IsOptional()
  // An allowlist, not a free string: `sortBy` is interpolated straight into
  // Prisma's `orderBy`, so any other value used to reach the driver and come
  // back as a 500 instead of a 400.
  @IsIn(EMPLOYEE_SORT_FIELDS)
  sortBy?: EmployeeSortField = 'createdAt';

  @ApiProperty({ example: 'asc', enum: ['asc', 'desc'], required: false })
  @IsOptional()
  @IsEnum(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc' = 'desc';
}

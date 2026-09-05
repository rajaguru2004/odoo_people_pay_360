import { IsString, IsOptional, IsUUID, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateDepartmentDto {
  @ApiProperty({
    example: 'IT',
    description: 'Department code (unique)',
    maxLength: 50,
  })
  @IsString()
  @MaxLength(50)
  code: string;

  @ApiProperty({
    example: 'Information Technology Department',
    description: 'Department name',
  })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiProperty({ example: 'Technology department', required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    example: '11111111-1111-1111-1111-111111111111',
    required: false,
    description: 'Parent department ID',
  })
  @IsOptional()
  @IsUUID()
  parentId?: string;

  @ApiProperty({
    example: '22222222-2222-2222-2222-222222222222',
    required: false,
    description: 'Manager employee ID',
  })
  @IsOptional()
  @IsUUID()
  managerId?: string;
}

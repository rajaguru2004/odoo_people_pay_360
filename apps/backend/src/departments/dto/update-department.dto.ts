import {
  IsString,
  IsOptional,
  IsUUID,
  MaxLength,
  IsBoolean,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateDepartmentDto {
  @ApiProperty({ example: 'IT', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  code?: string;

  @ApiProperty({
    example: 'Information Technology Department',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiProperty({ example: 'Technology department', required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    example: '11111111-1111-1111-1111-111111111111',
    required: false,
    nullable: true,
    description: 'Parent department ID. Send null to detach to top level.',
  })
  @IsOptional()
  @IsUUID()
  parentId?: string | null;

  @ApiProperty({
    example: '22222222-2222-2222-2222-222222222222',
    required: false,
  })
  @IsOptional()
  @IsUUID()
  managerId?: string;

  @ApiProperty({ example: true, required: false })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

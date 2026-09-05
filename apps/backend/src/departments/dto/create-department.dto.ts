import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateDepartmentDto {
  @ApiProperty({ example: 'FIN' })
  @IsString()
  @MaxLength(32)
  code: string;

  @ApiProperty({ example: 'Finance' })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ description: 'Employee who heads this department' })
  @IsOptional()
  @IsUUID()
  managerId?: string;
}

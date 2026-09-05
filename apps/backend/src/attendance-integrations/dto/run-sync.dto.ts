import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';

export class RunSyncDto {
  @ApiProperty({ example: '2026-07-01', description: 'Inclusive start (YYYY-MM-DD)' })
  @IsISO8601()
  from: string;

  @ApiProperty({ example: '2026-07-24', description: 'Inclusive end (YYYY-MM-DD)' })
  @IsISO8601()
  to: string;
}

export class PreviewSyncDto extends RunSyncDto {}

export class BulkMapEntryDto {
  @ApiProperty()
  @IsString()
  externalId: string;

  @ApiProperty()
  @IsUUID()
  employeeId: string;
}

export class BulkMapEmployeesDto {
  @ApiProperty({
    type: [BulkMapEntryDto],
    description: 'Links to apply. Each is validated independently; one bad row does not fail the rest.',
  })
  @IsArray()
  @ArrayMaxSize(2000)
  @ValidateNested({ each: true })
  @Type(() => BulkMapEntryDto)
  entries: BulkMapEntryDto[];
}

export class MapEmployeeDto {
  @ApiProperty({ description: "Employee id as the provider knows it" })
  @IsString()
  externalId: string;

  @ApiPropertyOptional({ description: 'Our employee. Omit together with unlink=true to detach.' })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional({ description: 'Clear the link instead of setting it' })
  @IsOptional()
  @IsBoolean()
  unlink?: boolean;
}

/**
 * Test-connection accepts unsaved form values so an admin can validate a base
 * URL / key before committing them — same affordance as the Copilot settings
 * page. Every field is optional; anything omitted falls back to what is stored.
 */
export class TestIntegrationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  baseUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  authHeaderName?: string;

  @ApiPropertyOptional({ description: 'Write-only. Omit to test with the stored secret.' })
  @IsOptional()
  @IsString()
  authSecret?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  externalBranchId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  externalTenantId?: string;
}

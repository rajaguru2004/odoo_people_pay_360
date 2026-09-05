import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AdoptTemplateDto {
  @ApiProperty({ example: 'OM', description: 'ISO-2 country preset to copy' })
  @IsOptional()
  @IsString()
  @MaxLength(2)
  country?: string;

  @ApiPropertyOptional({ enum: ['COMPANY', 'BRANCH'], default: 'COMPANY' })
  @IsOptional()
  @IsString()
  scope?: string;

  @ApiPropertyOptional({ description: 'Required when scope is BRANCH' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(150)
  name?: string;
}

export class RenameTemplateDto {
  @ApiProperty()
  @IsString()
  @MaxLength(150)
  name!: string;
}

export class UpsertSectionDto {
  @ApiPropertyOptional({ description: 'Required when creating; immutable after' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  sectionKey?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(150)
  label?: string;

  @ApiPropertyOptional({ description: 'lucide-react icon name' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  icon?: string;

  @ApiPropertyOptional({ description: 'Groups sections into create-wizard steps' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  wizardStep?: number;

  @ApiPropertyOptional({ description: 'Grid columns for this section' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(4)
  columns?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  displayOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ description: '[] means every role' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  visibleToRoles?: string[];
}

export class UpsertFieldDto {
  @ApiPropertyOptional({ description: 'Required when creating; immutable after' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  fieldKey?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  sectionId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(150)
  label?: string;

  @ApiPropertyOptional({ description: 'See FIELD_TYPES' })
  @IsOptional()
  @IsString()
  fieldType?: string;

  /**
   * Present so a client sending it gets a clear 400 from the service guard
   * rather than a silent strip by `forbidNonWhitelisted`. The service never
   * honours anything but COLUMN on an already-bound field, and always forces
   * JSONB when creating.
   */
  @ApiPropertyOptional({ description: 'Read-only in practice; see the service guard' })
  @IsOptional()
  @IsString()
  storage?: string;

  @ApiPropertyOptional({ description: 'See VALIDATION_TYPES' })
  @IsOptional()
  @IsString()
  validationType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  regex?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  minValue?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  maxValue?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minLength?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxLength?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @ApiPropertyOptional({ description: '[{ value, label }] for SELECT/MULTISELECT' })
  @IsOptional()
  @IsArray()
  options?: { value: string; label: string }[];

  @ApiPropertyOptional({ description: 'LibraryType name, or DEPARTMENT|BRANCH|EMPLOYEE' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  optionSource?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  placeholder?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  helpText?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  defaultValue?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(4)
  colSpan?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  displayOrder?: number;

  @ApiPropertyOptional({ description: '[] means every role' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  visibleToRoles?: string[];

  @ApiPropertyOptional({ description: '[] means every role' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  editableByRoles?: string[];

  @ApiPropertyOptional({ description: 'Visible to the employee on their own record' })
  @IsOptional()
  @IsBoolean()
  selfVisible?: boolean;

  @ApiPropertyOptional({ description: 'Employee may change it on their own record' })
  @IsOptional()
  @IsBoolean()
  selfEditable?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isSensitive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  includeInCompletion?: boolean;
}

export class ReorderDto {
  @ApiProperty({ type: [String], description: 'Ids in their new order' })
  @IsArray()
  @IsUUID('4', { each: true })
  order!: string[];

  @ApiPropertyOptional({ description: 'Target section when moving fields between sections' })
  @IsOptional()
  @IsUUID()
  sectionId?: string;
}

export class ActiveTemplateQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ enum: ['CREATE', 'EDIT', 'SELF'] })
  @IsOptional()
  @IsString()
  mode?: string;

  @ApiPropertyOptional({ description: 'Resolve as this employee (self-service view)' })
  @IsOptional()
  @IsUUID()
  employeeId?: string;
}

export class ListTemplatesQueryDto {
  @ApiPropertyOptional({ enum: ['COMPANY', 'BRANCH'] })
  @IsOptional()
  @IsString()
  scope?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  branchId?: string;
}

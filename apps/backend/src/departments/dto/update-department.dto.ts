import { OmitType, PartialType } from '@nestjs/swagger';
import { IsOptional, IsUUID, ValidateIf } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { CreateDepartmentDto } from './create-department.dto';

// `parentId` is dropped from the base before it is re-declared below. Widening
// it in place would be a type error — the override has to be assignable to what
// it overrides, and `string | null` is not assignable to `string`.
export class UpdateDepartmentDto extends PartialType(
  OmitType(CreateDepartmentDto, ['parentId'] as const),
) {
  /**
   * `null` detaches to top level; omitting the field leaves the parent alone.
   *
   * PartialType alone cannot express that difference — its `parentId?: string`
   * rejects an explicit null, so "move this department to the root" had no way
   * to be said at all.
   */
  @ApiPropertyOptional({
    nullable: true,
    description: 'null moves the department to the top level',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  parentId?: string | null;
}

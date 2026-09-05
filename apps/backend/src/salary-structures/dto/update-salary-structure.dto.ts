import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateSalaryStructureDto } from './create-salary-structure.dto';

/**
 * `employeeId` is not editable. A structure is keyed to one person
 * (`SalaryStructure.employeeId` is `@unique`), so moving it would give one
 * employee two pay definitions and leave the other with none — the fix for a
 * structure raised against the wrong person is to delete it and create theirs.
 *
 * `lines` is optional, but supplying it REPLACES the whole set rather than
 * merging into it: a rise that removes an allowance has to be expressible, and
 * a merge cannot express a removal.
 */
export class UpdateSalaryStructureDto extends PartialType(
  OmitType(CreateSalaryStructureDto, ['employeeId'] as const),
) {}

import { PartialType, OmitType } from '@nestjs/swagger';
import { CreateSalaryComponentDto } from './create-salary-component.dto';

/**
 * `code` and `type` are left out on purpose.
 *
 * Both are joined on by payslip lines that already exist. Renaming a code would
 * orphan every report that groups by it, and turning an earning into a
 * deduction would change the meaning of money already paid. Retire the
 * component and create its successor instead — the house idiom.
 */
export class UpdateSalaryComponentDto extends PartialType(
  OmitType(CreateSalaryComponentDto, ['code', 'type'] as const),
) {}

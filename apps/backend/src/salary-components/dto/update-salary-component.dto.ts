import { PartialType } from '@nestjs/swagger';
import { CreateSalaryComponentDto } from './create-salary-component.dto';

export class UpdateSalaryComponentDto extends PartialType(
  CreateSalaryComponentDto,
) {}

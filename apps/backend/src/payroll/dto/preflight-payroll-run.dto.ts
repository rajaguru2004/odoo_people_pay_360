import { OmitType } from '@nestjs/swagger';
import { CreatePayrollRunDto } from './create-payroll-run.dto';

/** The same question the run asks, asked without writing anything. */
export class PreflightPayrollRunDto extends OmitType(CreatePayrollRunDto, [
  'notes',
] as const) {}

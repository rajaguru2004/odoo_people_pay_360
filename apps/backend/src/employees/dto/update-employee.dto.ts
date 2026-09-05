import { PartialType } from '@nestjs/swagger';
import { CreateEmployeeDto } from './create-employee.dto';

/**
 * Every field optional EXCEPT that `employeeCode` stays editable on purpose:
 * codes get corrected during onboarding, and the unique constraint is what
 * stops a correction from colliding with an existing one.
 */
export class UpdateEmployeeDto extends PartialType(CreateEmployeeDto) {}

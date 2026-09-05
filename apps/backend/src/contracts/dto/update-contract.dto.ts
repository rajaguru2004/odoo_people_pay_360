import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateContractDto } from './create-contract.dto';

/**
 * `employeeId` is not editable. Moving a signed contract to a different person
 * would rewrite that person's employment history rather than correct anything —
 * the fix for a contract raised against the wrong employee is a new contract.
 */
export class UpdateContractDto extends PartialType(
  OmitType(CreateContractDto, ['employeeId'] as const),
) {}

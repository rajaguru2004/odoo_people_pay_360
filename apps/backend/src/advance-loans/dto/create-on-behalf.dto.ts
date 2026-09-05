import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';
import { CreateAdvanceLoanDto } from './create-advance-loan.dto';

/**
 * Filing on somebody else's behalf.
 *
 * The employee is named explicitly rather than inferred, and the filer is
 * recorded on the request (`createdOnBehalfBy`, `approvalSource = 'ON_BEHALF'`)
 * so the trail says who acted for whom. Both columns existed and were written
 * by nothing.
 */
export class CreateAdvanceLoanOnBehalfDto extends CreateAdvanceLoanDto {
  @ApiProperty({ description: 'The employee the request is for' })
  @IsUUID()
  employeeId: string;
}

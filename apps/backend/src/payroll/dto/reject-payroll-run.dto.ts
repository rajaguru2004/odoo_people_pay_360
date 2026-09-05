import { IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RejectPayrollRunDto {
  @ApiProperty({
    description:
      'Why the run was sent back. Required: a run returned to DRAFT with no reason gives the payroll officer nothing to correct.',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  reason: string;
}

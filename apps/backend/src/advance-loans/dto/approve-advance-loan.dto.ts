import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class ApproveAdvanceLoanDto {
  @ApiProperty({
    example: 'Approved — recover over 6 payroll cycles',
    description: 'Approval remarks',
    required: false,
  })
  @IsOptional()
  @IsString()
  remarks?: string;

  @ApiProperty({
    example: 6,
    description:
      'Number of repayment installments for a loan (ignored for advances)',
    required: false,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  installments?: number;

  @ApiProperty({
    example: 10,
    required: false,
    description:
      'Recovery priority — lower is recovered first when net pay cannot cover ' +
      'every loan. It is the FIRST sort key in the recovery allocator and no ' +
      'route exposed it, so every loan sat at 100 and the rung could only ever ' +
      'tie-break. Set by the approver, not the requester: which debt yields to ' +
      'which is the employer’s call.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  priority?: number;
}

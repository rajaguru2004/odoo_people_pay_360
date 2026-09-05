import { IsIn, IsInt, IsNumber, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class EligibilityCheckDto {
  @ApiProperty({
    required: false,
    description:
      'Only ADMIN/HR_MANAGER/MANAGER may ask about someone else; anyone else ' +
      'is forced to their own employee id.',
  })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiProperty({ example: 50000 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(9999999999.99)
  amount: number;

  @ApiProperty({ required: false, example: 6 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(600)
  installments?: number;

  @ApiProperty({ required: false, enum: ['ADVANCE', 'LOAN'] })
  @IsOptional()
  @IsIn(['ADVANCE', 'LOAN'])
  type?: string;
}

import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsOptional,
  IsUUID,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DESCRIPTOR_LENGTH } from './create-face-enrollment.dto';

export class VerifyFaceDto {
  @ApiProperty({
    type: [Number],
    description: `The ${DESCRIPTOR_LENGTH}-float probe to match. Never stored, never echoed back.`,
  })
  @IsArray()
  @ArrayMinSize(DESCRIPTOR_LENGTH)
  @ArrayMaxSize(DESCRIPTOR_LENGTH)
  @Type(() => Number)
  @IsNumber(
    { allowNaN: false, allowInfinity: false },
    { each: true, message: 'descriptor must contain only finite numbers' },
  )
  descriptor: number[];

  @ApiPropertyOptional({
    description:
      'Verify against ONE person rather than searching everybody. A kiosk that already knows who is standing at it sends this; an open terminal does not.',
  })
  @IsOptional()
  @IsUUID()
  employeeId?: string;
}

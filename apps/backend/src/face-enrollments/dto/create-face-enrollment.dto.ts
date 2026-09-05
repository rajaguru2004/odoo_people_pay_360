import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** face-api.js emits a fixed-width embedding. A different width is a bug. */
export const DESCRIPTOR_LENGTH = 128;

export class CreateFaceEnrollmentDto {
  @ApiProperty()
  @IsUUID()
  employeeId: string;

  @ApiProperty({
    type: [Number],
    description: `The ${DESCRIPTOR_LENGTH}-float embedding. Never echoed back.`,
  })
  @IsArray()
  @ArrayMinSize(DESCRIPTOR_LENGTH)
  @ArrayMaxSize(DESCRIPTOR_LENGTH)
  @Type(() => Number)
  @IsNumber(
    { allowNaN: false, allowInfinity: false },
    {
      each: true,
      message: 'descriptor must contain only finite numbers',
    },
  )
  descriptor: number[];

  @ApiProperty({ example: 0.82, description: "The detector's confidence, 0–1" })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1)
  quality: number;

  @ApiPropertyOptional({ description: 'Reference photo, if one was kept' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  imageUrl?: string;
}

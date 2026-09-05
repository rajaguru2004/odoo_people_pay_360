import { IsNotEmpty, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class FaceCheckInDto {
  @ApiProperty({
    description: 'Base64 encoded face image (data:image/jpeg;base64,...)',
  })
  @IsString()
  @IsNotEmpty()
  image: string;

  @ApiProperty({
    example: 13.0827,
    required: false,
    description: 'Employee GPS latitude at time of check-in',
  })
  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  @Type(() => Number)
  latitude?: number;

  @ApiProperty({
    example: 80.2707,
    required: false,
    description: 'Employee GPS longitude at time of check-in',
  })
  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  @Type(() => Number)
  longitude?: number;

  @ApiProperty({
    required: false,
    description: 'GPS accuracy radius in meters, if available from the browser',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  accuracy?: number;
}

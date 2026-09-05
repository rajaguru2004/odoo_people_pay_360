import { IsString, IsNotEmpty, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RegisterFaceDto {
  @ApiProperty({
    description: 'Base64 encoded image (data:image/jpeg;base64,...)',
  })
  @IsString()
  @IsNotEmpty()
  image: string;

  @ApiProperty({
    description: 'Employee ID (for admin registration)',
    required: false,
  })
  @IsString()
  @IsOptional()
  employeeId?: string;
}

import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ElevateDto {
  @ApiProperty({ description: 'The developer password' })
  @IsString()
  @IsNotEmpty()
  // Bounded so a huge body cannot be pushed through bcrypt as a cheap CPU
  // sink. bcrypt only reads the first 72 bytes anyway.
  @MaxLength(200)
  password: string;
}

import { IsString, IsNotEmpty, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Confirmation payload for the sample-data seed. The literal must equal "SEED"
 * (defence-in-depth behind the UI confirmation step).
 */
export class SeedSampleDto {
  @ApiProperty({ example: 'SEED', description: 'Must be exactly "SEED" to proceed.' })
  @IsString()
  @IsNotEmpty()
  @IsIn(['SEED'])
  confirm: string;
}

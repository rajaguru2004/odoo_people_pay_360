import { IsString, IsNotEmpty, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Confirmation payload for the destructive "reset database to baseline" action.
 * The literal must equal "RESET" — a defence-in-depth check behind the UI's
 * type-to-confirm gate.
 */
export class ResetDatabaseDto {
  @ApiProperty({
    example: 'RESET',
    description: 'Must be exactly "RESET" to proceed with the reset.',
  })
  @IsString()
  @IsNotEmpty()
  @IsIn(['RESET'])
  confirm: string;
}

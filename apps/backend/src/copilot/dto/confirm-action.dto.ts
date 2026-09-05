import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsUUID } from 'class-validator';

export class ConfirmActionDto {
  @ApiProperty({ description: 'Pending action id returned by /copilot/chat' })
  @IsUUID()
  actionId: string;

  @ApiProperty({ description: 'true = execute the action, false = reject it' })
  @IsBoolean()
  approve: boolean;
}

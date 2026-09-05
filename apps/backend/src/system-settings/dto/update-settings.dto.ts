import { IsObject } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateSettingsDto {
  @ApiProperty({
    example: { allow_multiple_checkin: 'true' },
    description: 'Key-value pairs of settings to update',
  })
  @IsObject()
  settings: Record<string, string>;
}

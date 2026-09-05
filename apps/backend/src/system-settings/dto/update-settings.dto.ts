import { IsObject } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateSettingsDto {
  @ApiProperty({
    description:
      'Flat key/value map. Keys absent from the body are left untouched.',
    example: { company_name: 'People Pay 360', primary_color: '#00358F' },
  })
  @IsObject()
  settings: Record<string, string>;
}

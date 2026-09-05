import { IsBoolean, IsOptional, IsUUID } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class ListTeamsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiPropertyOptional({
    default: false,
    description: 'Include teams that have been stood down',
  })
  @IsOptional()
  // Query strings carry `true`, not a boolean; without this the string is
  // truthy and the flag can never be turned off once it has been sent.
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeInactive?: boolean;
}

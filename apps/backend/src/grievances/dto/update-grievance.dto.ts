import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { GRIEVANCE_STATUSES } from '../grievance-visibility.util';

export class UpdateGrievanceDto {
  @ApiPropertyOptional({ enum: GRIEVANCE_STATUSES })
  @IsOptional()
  @IsIn(GRIEVANCE_STATUSES as unknown as string[])
  status?: string;

  @ApiPropertyOptional({ description: 'User id of the handler taking the case' })
  @IsOptional()
  @IsUUID()
  assignedToId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  resolution?: string;

  @ApiPropertyOptional({ description: 'Recorded on the trail beside this change' })
  @IsOptional()
  @IsString()
  note?: string;
}

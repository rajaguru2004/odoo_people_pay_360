import { IsOptional, IsString, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class NominateDto {
  @ApiProperty()
  @IsUUID()
  sessionId: string;

  @ApiProperty()
  @IsUUID()
  employeeId: string;

  @ApiPropertyOptional({ description: 'Why this person needs this course' })
  @IsOptional()
  @IsString()
  justification?: string;
}

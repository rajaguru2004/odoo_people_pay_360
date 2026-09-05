import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const NOMINATION_SOURCES = ['MANUAL', 'APPRAISAL'] as const;

export class NominateDto {
  @ApiProperty()
  @IsUUID()
  sessionId: string;

  @ApiProperty()
  @IsUUID()
  employeeId: string;

  @ApiPropertyOptional({
    enum: NOMINATION_SOURCES,
    default: 'MANUAL',
    description: "APPRAISAL records that this came from the AI appraisal engine",
  })
  @IsOptional()
  @IsIn(NOMINATION_SOURCES as unknown as string[])
  source?: string;

  @ApiPropertyOptional({
    description: 'The AppraisalResult this need was derived from — kept as provenance',
  })
  @IsOptional()
  @IsUUID()
  appraisalResultId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  justification?: string;
}

import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const REVIEW_ACTIONS = ['APPROVE', 'REJECT'] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

export class ReviewCorrectionDto {
  @ApiProperty({ enum: REVIEW_ACTIONS })
  @IsIn(REVIEW_ACTIONS, {
    message: `action must be one of ${REVIEW_ACTIONS.join(', ')}`,
  })
  action: ReviewAction;

  @ApiPropertyOptional({ example: 'Confirmed against the gate log' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reviewNote?: string;
}

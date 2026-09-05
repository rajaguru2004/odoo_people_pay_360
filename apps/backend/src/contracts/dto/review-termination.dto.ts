import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum TerminationReviewAction {
  APPROVE = 'APPROVE',
  REJECT = 'REJECT',
}

export class ReviewTerminationDto {
  @ApiProperty({ enum: TerminationReviewAction })
  @IsEnum(TerminationReviewAction)
  action: TerminationReviewAction;

  @ApiPropertyOptional({ description: 'Shown to the requester' })
  @IsOptional()
  @IsString()
  reviewNote?: string;
}

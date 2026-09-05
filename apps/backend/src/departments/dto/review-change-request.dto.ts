import { IsString, IsEnum, IsOptional, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export enum ReviewAction {
  APPROVE = 'APPROVE',
  REJECT = 'REJECT',
}

export class ReviewChangeRequestDto {
  @ApiProperty({
    example: 'APPROVE',
    enum: ReviewAction,
    description: 'Approval decision',
  })
  @IsEnum(ReviewAction)
  action: ReviewAction;

  @ApiProperty({
    example: 'Reviewed and approved the proposal',
    required: false,
    description: 'Review note/comment',
  })
  @IsOptional()
  @IsString()
  @MinLength(5, { message: 'Review note must be at least 5 characters' })
  reviewNote?: string;
}

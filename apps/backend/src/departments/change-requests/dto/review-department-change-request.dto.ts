import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum ChangeRequestReviewAction {
  APPROVE = 'APPROVE',
  REJECT = 'REJECT',
}

export class ReviewDepartmentChangeRequestDto {
  @ApiProperty({ enum: ChangeRequestReviewAction })
  @IsEnum(ChangeRequestReviewAction)
  action: ChangeRequestReviewAction;

  @ApiPropertyOptional({
    description: 'Shown to the requester alongside the decision',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reviewNote?: string;
}

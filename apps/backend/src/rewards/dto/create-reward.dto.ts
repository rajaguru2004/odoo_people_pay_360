import {
  IsString,
  IsDateString,
  IsUUID,
  IsNumber,
  Min,
  IsOptional,
  IsEnum,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateRewardDto {
  @ApiProperty({ example: '11111111-1111-1111-1111-111111111111' })
  @IsUUID()
  employeeId: string;

  @ApiProperty({ example: 'Excellent completion of project ABC' })
  @IsString()
  reason: string;

  @ApiProperty({ example: 2000000, description: 'Reward amount (VND)' })
  @IsNumber()
  @Min(0)
  amount: number;

  @ApiProperty({ example: '2026-01-15' })
  @IsDateString()
  rewardDate: string;

  @ApiProperty({
    example: 'BONUS',
    enum: ['BONUS', 'CERTIFICATE', 'PROMOTION', 'OTHER'],
    required: false,
  })
  @IsOptional()
  @IsEnum(['BONUS', 'CERTIFICATE', 'PROMOTION', 'OTHER'])
  rewardType?: string;
}

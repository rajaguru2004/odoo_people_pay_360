import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TerminationCategory } from '@prisma/client';

export class CreateTerminationDto {
  @ApiProperty()
  @IsUUID()
  contractId: string;

  @ApiProperty({ enum: TerminationCategory })
  @IsEnum(TerminationCategory)
  category: TerminationCategory;

  @ApiProperty({ example: '2026-03-01', description: 'When notice was given' })
  @IsDateString()
  noticeDate: string;

  @ApiProperty({ example: '2026-03-31', description: 'Last working day' })
  @IsDateString()
  terminationDate: string;

  @ApiProperty()
  @IsString()
  reason: string;

  @ApiPropertyOptional({
    default: true,
    description: 'False when the notice period is being paid out instead',
  })
  @IsOptional()
  @IsBoolean()
  noticeServed?: boolean;
}

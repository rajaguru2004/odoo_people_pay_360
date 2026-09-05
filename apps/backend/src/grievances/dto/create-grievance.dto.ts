import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateGrievanceDto {
  @ApiProperty({ description: 'A GRIEVANCE_CATEGORY library label' })
  @IsString()
  @MaxLength(100)
  category: string;

  @ApiProperty()
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  subject: string;

  @ApiProperty()
  @IsString()
  @MinLength(3)
  description: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'Narrows visibility to ADMIN, HR, the complainant and the assigned handler',
  })
  @IsOptional()
  @IsBoolean()
  isConfidential?: boolean;

  @ApiPropertyOptional({
    description:
      'Who the grievance is about. That person can never see it, whatever their role.',
  })
  @IsOptional()
  @IsUUID()
  againstEmployeeId?: string;
}

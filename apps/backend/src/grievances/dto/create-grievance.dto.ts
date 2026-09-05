import { IsBoolean, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateGrievanceDto {
  @ApiProperty({ description: 'GRIEVANCE_CATEGORY library label' })
  @IsString()
  @MaxLength(100)
  category: string;

  @ApiProperty()
  @IsString()
  @MaxLength(200)
  subject: string;

  @ApiProperty()
  @IsString()
  description: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'Restricts visibility to ADMIN, HR_MANAGER, the complainant and the assigned handler',
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

import { IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class ApproveTerminationDto {
  @IsUUID()
  @IsNotEmpty()
  approverId: string;

  @IsString()
  @IsOptional()
  comments?: string;

  /**
   * Proceed even though the employee still holds company assets (write-off,
   * lost item, urgent exit). ADMIN/HR_MANAGER only, and always audited as
   * CLEARANCE_OVERRIDDEN.
   */
  @IsString()
  @IsOptional()
  clearanceOverrideReason?: string;
}

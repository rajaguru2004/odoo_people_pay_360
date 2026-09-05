import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  ArrayMinSize,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  APPROVAL_REQUEST_TYPES,
  type ApprovalRequestType,
} from '../approval-kind.registry';

export const APPROVER_TYPES = [
  'SUPERVISOR',
  'MANAGER',
  'HR_MANAGER',
  'ADMIN',
] as const;
export type ApproverTypeLiteral = (typeof APPROVER_TYPES)[number];

export const APPROVAL_MODES = ['SEQUENTIAL', 'PARALLEL'] as const;
export type ApprovalModeLiteral = (typeof APPROVAL_MODES)[number];

export class WorkflowStepDto {
  @ApiProperty({ enum: APPROVER_TYPES })
  @IsIn(APPROVER_TYPES as unknown as string[])
  approverType: ApproverTypeLiteral;
}

export class UpsertWorkflowDto {
  // Sourced from the registry so a new approvable type never needs an edit here.
  @ApiProperty({ enum: APPROVAL_REQUEST_TYPES })
  @IsIn(APPROVAL_REQUEST_TYPES as unknown as string[])
  requestType: ApprovalRequestType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({
    enum: APPROVAL_MODES,
    default: 'SEQUENTIAL',
    description:
      'SEQUENTIAL: a step is actionable only after the previous approver accepts. PARALLEL: every step is actionable at once and all must approve.',
  })
  @IsOptional()
  @IsIn(APPROVAL_MODES as unknown as string[])
  mode?: ApprovalModeLiteral;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiProperty({
    type: [WorkflowStepDto],
    description: 'Ordered steps; array order defines the approval sequence.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => WorkflowStepDto)
  steps: WorkflowStepDto[];
}

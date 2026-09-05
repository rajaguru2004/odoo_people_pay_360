import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ApprovalMode, ApproverType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import {
  APPROVAL_REQUEST_TYPES,
  type ApprovalRequestType,
} from '../approval-kind.registry';

export class WorkflowStepDto {
  @ApiProperty({ enum: ApproverType, example: ApproverType.SUPERVISOR })
  @IsEnum(ApproverType)
  approverType: ApproverType;
}

export class UpsertWorkflowDto {
  // Sourced from the registry, so adding a governable type never needs an edit
  // here — the enum value and the registry entry are the whole change.
  @ApiProperty({ enum: APPROVAL_REQUEST_TYPES, example: 'LEAVE' })
  @IsEnum(Object.fromEntries(APPROVAL_REQUEST_TYPES.map((t) => [t, t])))
  requestType: ApprovalRequestType;

  @ApiPropertyOptional({ example: 'Leave — supervisor then HR' })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  name?: string;

  @ApiPropertyOptional({
    enum: ApprovalMode,
    default: ApprovalMode.SEQUENTIAL,
    description:
      'SEQUENTIAL: a step opens only once the previous approver accepts. PARALLEL: every step opens at once and all must approve.',
  })
  @IsOptional()
  @IsEnum(ApprovalMode)
  mode?: ApprovalMode;

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

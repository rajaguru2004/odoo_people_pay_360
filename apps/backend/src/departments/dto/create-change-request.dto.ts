import {
  IsString,
  IsUUID,
  IsOptional,
  IsDateString,
  IsEnum,
  MinLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export enum ChangeRequestType {
  CHANGE_MANAGER = 'CHANGE_MANAGER',
  CHANGE_PARENT = 'CHANGE_PARENT',
  RESTRUCTURE = 'RESTRUCTURE',
}

export class CreateChangeRequestDto {
  @ApiProperty({
    example: 'CHANGE_MANAGER',
    enum: ChangeRequestType,
    description: 'Type of change request',
  })
  @IsEnum(ChangeRequestType)
  requestType: ChangeRequestType;

  @ApiProperty({
    example: '22222222-2222-2222-2222-222222222222',
    required: false,
    description: 'New manager ID (for CHANGE_MANAGER)',
  })
  @IsOptional()
  @IsUUID()
  newManagerId?: string;

  @ApiProperty({
    example: '11111111-1111-1111-1111-111111111111',
    required: false,
    description: 'New parent department ID (for CHANGE_PARENT)',
  })
  @IsOptional()
  @IsUUID()
  newParentId?: string;

  @ApiProperty({
    example: 'Need to change department head due to retirement',
    description: 'Reason for the change',
  })
  @IsString()
  @MinLength(10, { message: 'Reason must be at least 10 characters' })
  reason: string;

  @ApiProperty({
    example: '2026-03-01T00:00:00.000Z',
    required: false,
    description: 'Effective date of the change',
  })
  @IsOptional()
  @IsDateString()
  effectiveDate?: string;
}

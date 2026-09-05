import { IsArray, IsDateString, IsEnum, IsOptional, IsUUID } from 'class-validator';

export enum AppraisalPeriodPreset {
  LAST_MONTH = 'LAST_MONTH',
  LAST_QUARTER = 'LAST_QUARTER',
  LAST_6_MONTHS = 'LAST_6_MONTHS',
  LAST_YEAR = 'LAST_YEAR',
  CUSTOM = 'CUSTOM',
}

export class CreateAppraisalRunDto {
  @IsEnum(AppraisalPeriodPreset)
  preset!: AppraisalPeriodPreset;

  /** Required when preset = CUSTOM. */
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  departmentIds?: string[];

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  employeeIds?: string[];
}

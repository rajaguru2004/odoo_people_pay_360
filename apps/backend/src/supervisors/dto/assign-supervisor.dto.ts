import { IsArray, IsOptional, IsUUID, ArrayMinSize, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AssignSupervisorDto {
  @ApiProperty({ description: 'Employee who gets a supervisor' })
  @IsUUID()
  employeeId: string;

  @ApiProperty({ description: 'Supervisor (an employee id)' })
  @IsUUID()
  supervisorId: string;
}

export class BulkAssignSupervisorDto {
  @ApiProperty({ type: [String], description: 'Employees to assign' })
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('all', { each: true })
  employeeIds: string[];

  @ApiProperty({ description: 'Supervisor (an employee id)' })
  @IsUUID()
  supervisorId: string;
}

export class UnassignSupervisorDto {
  @ApiPropertyOptional({ description: 'Employee to detach from its supervisor' })
  @IsOptional()
  @IsUUID()
  employeeId?: string;
}

export class CreateSupervisorTeamDto {
  @ApiProperty({ description: 'Team name' })
  @IsString()
  name: string;

  @ApiProperty({ description: 'Supervisor for the team (an employee id)' })
  @IsUUID()
  supervisorId: string;

  @ApiPropertyOptional({ type: [String], description: 'Member employee ids' })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  memberIds?: string[];

  @ApiPropertyOptional({ description: 'Optional description' })
  @IsOptional()
  @IsString()
  description?: string;
}

export class UpdateSupervisorTeamDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ description: 'New supervisor (an employee id)' })
  @IsOptional()
  @IsUUID()
  supervisorId?: string;

  @ApiPropertyOptional({ type: [String], description: 'Full replacement member list' })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  memberIds?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;
}

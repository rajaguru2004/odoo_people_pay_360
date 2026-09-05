import { ArrayMinSize, IsArray, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AssignSupervisorDto {
  @ApiProperty({ description: 'Employee who gets a supervisor' })
  @IsUUID()
  employeeId: string;

  @ApiProperty({ description: 'The supervisor, as an employee id' })
  @IsUUID()
  supervisorId: string;
}

export class BulkAssignSupervisorDto {
  @ApiProperty({
    type: [String],
    description: 'Employees to route to one supervisor',
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('all', { each: true })
  employeeIds: string[];

  @ApiProperty({ description: 'The supervisor, as an employee id' })
  @IsUUID()
  supervisorId: string;
}

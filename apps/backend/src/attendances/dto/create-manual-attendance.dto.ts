import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateManualAttendanceDto {
  @ApiProperty({ example: 'employee-uuid-here', description: 'Employee UUID' })
  @IsUUID()
  @IsNotEmpty()
  employeeId: string;

  @ApiProperty({
    example: '2026-05-20',
    description: 'Date of attendance (YYYY-MM-DD)',
  })
  @IsString()
  @IsNotEmpty()
  date: string;

  @ApiProperty({
    example: '08:30',
    description: 'Check-in time (HH:MM or ISO timestamp)',
    required: false,
  })
  @IsString()
  @IsOptional()
  checkIn?: string;

  @ApiProperty({
    example: '17:30',
    description: 'Check-out time (HH:MM or ISO timestamp)',
    required: false,
  })
  @IsString()
  @IsOptional()
  checkOut?: string;

  @ApiProperty({
    example: 'PRESENT',
    description: 'Attendance status (PRESENT, ABSENT, LEAVE, HOLIDAY)',
    enum: ['PRESENT', 'ABSENT', 'LEAVE', 'HOLIDAY'],
    required: false,
  })
  // `Attendance.status` is a free VarChar and the service writes
  // `dto.status || 'PRESENT'` verbatim, so an invented value was persisted and
  // then counted as neither present nor absent by `getOverview`, and matched no
  // filter in `getAttendanceList`. Payroll reads this column. The allowlist is
  // the four values this DTO has always documented.
  @IsIn(['PRESENT', 'ABSENT', 'LEAVE', 'HOLIDAY'], {
    message: 'status must be one of PRESENT, ABSENT, LEAVE, HOLIDAY',
  })
  @IsString()
  @IsOptional()
  status?: string;

  @ApiProperty({
    example: 'Manual entry by Admin',
    description: 'Notes or reason',
    required: false,
  })
  @IsString()
  @IsOptional()
  notes?: string;
}

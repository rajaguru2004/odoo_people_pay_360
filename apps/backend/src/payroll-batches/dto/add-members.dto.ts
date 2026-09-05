import { ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * The body of `POST /payroll-batches/:id/members`.
 *
 * A class rather than a bare `@Body('employeeIds')`: NestJS's ValidationPipe has
 * nothing to validate against a raw parameter, so `{}` reached the service as
 * `undefined` and `Array.from(new Set(undefined))` threw a 500 the caller could
 * not act on. `@IsUUID` also stops a batch quietly accepting ids that can never
 * match an employee.
 */
export class AddBatchMembersDto {
  @ApiProperty({ type: [String], description: 'Employee UUIDs to add' })
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  employeeIds: string[];
}

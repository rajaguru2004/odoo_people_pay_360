import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * The body of `PATCH /approval-workflows/:id/active`.
 *
 * A class rather than a bare `@Body('isActive')`: ValidationPipe has nothing to
 * validate against a raw parameter, so `{}` would arrive as `undefined` and
 * `{ isActive: 'false' }` as a truthy string. Either silently flips a chain on
 * or off, which is the difference between leave needing a supervisor and leave
 * applying itself.
 */
export class SetWorkflowActiveDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  isActive: boolean;
}

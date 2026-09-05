import { IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * The body of `PATCH /approval-workflows/:id/active`.
 *
 * A class rather than a bare `@Body('isActive')`: NestJS's ValidationPipe has
 * nothing to validate against a raw parameter, so `{}` arrived as `undefined`
 * and `{ isActive: 'false' }` arrived as a truthy string — either of which
 * silently turns an approval chain ON or OFF, which is the difference between a
 * bank change needing a supervisor and applying immediately.
 */
export class SetWorkflowActiveDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  isActive: boolean;
}

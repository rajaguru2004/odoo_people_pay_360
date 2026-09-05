import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * `POST /tasks/:id/move-status` bound `@Body('statusId')` directly (finding
 * R40). `ValidationPipe` only validates class metatypes, so binding a bare
 * property means it never runs: `{}`, `{statusId: 42}` and
 * `{statusId: 'nope'}` all reached the service, which then asked Prisma for a
 * `findUnique` on a non-uuid. Exactly the omission shape recorded for the
 * letters `reject` reason (R5) and for `AddDependencyDto` (R61).
 */
export class MoveStatusDto {
  @ApiProperty({ example: 'uuid-of-workflow-status' })
  @IsUUID()
  statusId: string;
}

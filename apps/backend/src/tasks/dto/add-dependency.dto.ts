import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** Mirrors the Prisma `DependencyType` enum. */
export const DEPENDENCY_TYPES = [
  'BLOCKS',
  'BLOCKED_BY',
  'RELATES_TO',
  'DUPLICATES',
] as const;

/**
 * `POST /tasks/:id/dependencies` bound `@Body('blockingTaskId')` and
 * `@Body('type')` directly, so the ValidationPipe never ran on either and an
 * unknown type reached the Postgres enum as a 500 (finding R61, the same
 * no-DTO shape as the letters `reject` reason).
 */
export class AddDependencyDto {
  @ApiProperty({ example: 'uuid-of-blocking-task' })
  @IsUUID()
  blockingTaskId: string;

  @ApiProperty({
    required: false,
    enum: DEPENDENCY_TYPES,
    default: 'BLOCKS',
  })
  @IsOptional()
  @IsEnum(DEPENDENCY_TYPES)
  type?: (typeof DEPENDENCY_TYPES)[number];
}

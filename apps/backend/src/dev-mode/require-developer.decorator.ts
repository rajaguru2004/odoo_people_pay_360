import { SetMetadata } from '@nestjs/common';
import { REQUIRE_DEVELOPER_KEY } from './dev-mode.constants';

/**
 * Marks a route (or a whole controller) as reachable only by an ADMIN who has
 * stepped up into developer mode.
 *
 * Must be paired with `DevModeGuard` in `@UseGuards(...)` — this app registers
 * no global guards, so metadata alone enforces nothing.
 */
export const RequireDeveloper = () => SetMetadata(REQUIRE_DEVELOPER_KEY, true);

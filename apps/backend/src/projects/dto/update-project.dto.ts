import { PartialType } from '@nestjs/swagger';
import { CreateProjectDto } from './create-project.dto';

/**
 * Every field optional, every per-field rule inherited — including the hex
 * `color` rule added for R49.
 *
 * The `startDate` ≤ `endDate` rule (R48) deliberately does NOT live here.
 * `PartialType` is exactly where a cross-field rule gets lost: a PATCH may send
 * only one half of the pair, and a DTO cannot see the half already stored. It
 * is enforced in `ProjectsService.update()` against the EFFECTIVE pair, so it
 * holds on create, on a two-field PATCH, and on a one-field PATCH alike.
 */
export class UpdateProjectDto extends PartialType(CreateProjectDto) {}

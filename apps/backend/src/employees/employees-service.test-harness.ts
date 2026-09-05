/**
 * Build an EmployeesService for a unit spec using NAMED dependencies.
 *
 * Why this exists: several specs used to construct the service positionally
 * behind an `as unknown as new (...args: any[])` cast, which defeats
 * typechecking entirely. When the constructor grew two parameters during the
 * profile-template merge, three of those specs silently injected the wrong stub
 * into `this.templates` and failed at runtime with
 * `Cannot read properties of undefined (reading 'resolve')` — a compile error
 * would have been far cheaper.
 *
 * Adding a constructor parameter now means adding one optional key here, and
 * every spec keeps working. Keep DEP_ORDER in step with the constructor.
 */
import { EmployeesService } from './employees.service';

/** Constructor parameter names, in declaration order. Append only. */
const DEP_ORDER = [
  'prisma',
  'activityService',
  'mailService',
  'settingsService',
  'storage',
  'clearance',
  'templates',
  'supervisors',
] as const;

export type EmployeesServiceDeps = Partial<
  Record<(typeof DEP_ORDER)[number], any>
>;

/**
 * Any dependency left unspecified becomes `{}` — enough for the many specs that
 * never touch it, and an obvious `undefined is not a function` for the ones that
 * do, pointing at the stub they forgot rather than at an off-by-one.
 */
export function buildEmployeesService(
  deps: EmployeesServiceDeps = {},
): EmployeesService {
  const Ctor = EmployeesService as unknown as new (
    ...args: any[]
  ) => EmployeesService;
  return new Ctor(...DEP_ORDER.map((name) => deps[name] ?? {}));
}

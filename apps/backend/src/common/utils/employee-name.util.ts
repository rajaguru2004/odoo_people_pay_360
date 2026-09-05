/**
 * The joined name the self-service payloads print.
 *
 * Employee records carry `firstName` and `lastName` separately and most screens
 * join them in the browser. The self-service reads are the exception: their
 * rows are trimmed projections of a person rather than employee records, and
 * shipping two columns per row so the client can join them again buys nothing.
 */
export interface NameParts {
  firstName?: string | null;
  lastName?: string | null;
}

export function joinName(person: NameParts): string {
  return [person.firstName, person.lastName].filter(Boolean).join(' ');
}

/**
 * Add `fullName` to an employee projection, keeping the parts beside it.
 *
 * Both are kept on purpose: `fullName` is what a list prints, and the parts are
 * what an avatar's initials come from.
 */
export function withFullName<T extends NameParts>(
  person: T,
): T & { fullName: string };
export function withFullName<T extends NameParts>(
  person: T | null | undefined,
): (T & { fullName: string }) | null;
export function withFullName<T extends NameParts>(person: T | null | undefined) {
  if (!person) return null;
  return { ...person, fullName: joinName(person) };
}

/**
 * Canonical contract enums.
 *
 * NOTE: `@IsEnum()` must be given an enum object (or `as const` object) — NOT a
 * plain string array. class-validator derives the "one of the following values"
 * list via `getValidEnumValues`, which filters out numeric keys; a plain array
 * has only numeric keys, so the allowed-values list comes back EMPTY and the
 * validation error reads "contractType must be one of the following values: ".
 * Using these enums makes both the validation and the error message correct.
 */
export enum ContractType {
  PROBATION = 'PROBATION',
  FIXED_TERM = 'FIXED_TERM',
  INDEFINITE = 'INDEFINITE',
}

export enum WorkType {
  FULL_TIME = 'FULL_TIME',
  PART_TIME = 'PART_TIME',
}

export enum ContractStatus {
  ACTIVE = 'ACTIVE',
  EXPIRED = 'EXPIRED',
  TERMINATED = 'TERMINATED',
}

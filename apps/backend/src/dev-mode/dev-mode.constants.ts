/**
 * Developer mode — a step-up elevation on top of an existing ADMIN session.
 *
 * The settings guarded by this module are operator/vendor controls, not tenant
 * controls: the LLM endpoint and key, the WhatsApp/Evolution credentials, SMTP,
 * the attendance-integration provider configs, the WPS employer profiles, the
 * employee-field template, and the two destructive maintenance actions (load
 * sample data, reset database). A customer ADMIN must not be able to see or
 * reach any of them.
 *
 * The elevation deliberately does NOT introduce a new role. The admin stays
 * signed in as themselves and mints a short-lived second token, so every audit
 * row still carries the real person's userId.
 */

/** Header carrying the elevation token. Kept separate from `Authorization` so
 *  the login/refresh flow is untouched and an access token alone is never
 *  sufficient. */
export const DEV_TOKEN_HEADER = 'x-dev-token';

/** Metadata key set by `@RequireDeveloper()`. */
export const REQUIRE_DEVELOPER_KEY = 'requireDeveloper';

/** Only an ADMIN may elevate. Elevation widens what an admin can do; it is not
 *  a way for a lower role to climb. */
export const ELEVATION_ELIGIBLE_ROLES: readonly string[] = ['ADMIN'];

export const DEFAULT_DEV_MODE_TTL_MINUTES = 20;

/** Audit actions written by this module. */
export const DEV_MODE_AUDIT = {
  RESOURCE: 'DevMode',
  ELEVATE_SUCCESS: 'DEV_MODE_ELEVATE',
  ELEVATE_FAILURE: 'DEV_MODE_ELEVATE_FAILED',
  REVOKE: 'DEV_MODE_REVOKE',
} as const;

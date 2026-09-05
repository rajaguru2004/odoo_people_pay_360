import {
  DynamicConfigField,
  DynamicConfigFieldType,
} from '../../common/config-schema/dynamic-config-field';

/**
 * Declarative description of the settings a provider needs.
 *
 * This is what makes the framework pluggable end-to-end: the admin UI renders
 * its form from this array, so adding a second vendor is one adapter class and
 * zero frontend work. Nothing here is vendor-specific.
 *
 * The shape itself is shared with the other schema-driven settings frameworks
 * (see DynamicConfigField) so one frontend renderer serves all of them. What
 * stays here is attendance-specific: WHERE a field's value is stored.
 *
 * For a provider's fields, a `name` matching a column on AttendanceIntegration
 * (see TOP_LEVEL_CONFIG_FIELDS below) is stored on the row; anything else is
 * stored inside the `options` JSON blob.
 */
export type ProviderConfigFieldType = DynamicConfigFieldType;
export type ProviderConfigField = DynamicConfigField;

/** Column names on AttendanceIntegration that a configSchema field may target directly. */
export const TOP_LEVEL_CONFIG_FIELDS = [
  'baseUrl',
  'authScheme',
  'authHeaderName',
  'authSecret',
  'externalBranchId',
  'externalTenantId',
] as const;

export type TopLevelConfigField = (typeof TOP_LEVEL_CONFIG_FIELDS)[number];

export function isTopLevelConfigField(name: string): name is TopLevelConfigField {
  return (TOP_LEVEL_CONFIG_FIELDS as readonly string[]).includes(name);
}

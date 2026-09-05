/**
 * Declarative description of a settings field, rendered generically by the admin
 * UI rather than hand-coded per feature.
 *
 * This is what makes a plug-in framework pluggable end-to-end: an adapter
 * declares the settings it needs as data, the settings form is generated from
 * that declaration, and adding the second adapter costs zero frontend work.
 *
 * Shared, not duplicated: the attendance-integrations framework introduced this
 * shape for external attendance providers, and the WPS wage-file formats need
 * exactly the same contract for their employer-registration and per-run fields.
 * One type means one frontend renderer for both.
 *
 * Nothing here is specific to any feature. Where a value is STORED is the
 * consuming module's business — see e.g. TOP_LEVEL_CONFIG_FIELDS in
 * attendance-integrations, which routes some names to columns and the rest to a
 * JSON blob.
 */
export type DynamicConfigFieldType =
  | 'text'
  | 'password'
  | 'number'
  | 'select'
  | 'boolean';

export interface DynamicConfigField {
  /** Stable key the value is stored under. Never rename — values are persisted. */
  name: string;
  label: string;
  type: DynamicConfigFieldType;
  required: boolean;
  default?: string | number | boolean;
  /** Only for `type: 'select'`. */
  options?: { value: string; label: string }[];
  /** Rendered by the settings page's InfoHint tooltip. */
  help?: string;
  placeholder?: string;
  /**
   * Write-only. The value is encrypted at rest and never sent back to the
   * browser — the UI shows a masked hint plus Replace/Clear controls.
   */
  secret?: boolean;
}

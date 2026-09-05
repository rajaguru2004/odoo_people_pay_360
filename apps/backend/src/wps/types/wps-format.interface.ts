import { DynamicConfigField } from '../../common/config-schema/dynamic-config-field';
import { WpsFinding } from './wps-finding';
import { WpsRunPayload } from './wps-payload';

/** One produced file. Several GCC schemes need a header file plus a detail file. */
export interface WpsArtifact {
  /** Bank-mandated filename. Formats own their own naming convention. */
  fileName: string;
  bytes: Buffer;
  mimeType: string;
  /** Exactly one PRIMARY per run — the one the fingerprint and download default to. */
  role: 'PRIMARY' | 'COMPANION';
}

/** A government identifier the format cannot produce a row without. */
export interface WpsIdentifierRequirement {
  /** A LegalDocumentCategory value, e.g. 'LABOUR_CARD'. */
  category: string;
  label: string;
  severity: 'BLOCKING' | 'WARNING';
  /** Optional check on EmployeeLegalDocument.documentNumber. */
  pattern?: string;
  /** Must not be expired at the payment date. */
  mustBeUnexpired?: boolean;
}

/**
 * The contract every wage-file format implements.
 *
 * Adding a country:
 *   1. implement this interface in `formats/<country>-<scheme>.format.ts`
 *   2. add it to `formats/wps-format.registry.ts`
 *
 * Nothing else changes — no migration, no controller edit, no frontend work. The
 * settings form is generated from `employerConfigSchema` + `runOptionsSchema`, and
 * the pre-flight from `validate()` + `requiredIdentifiers`.
 *
 * If adding country #2 requires a change anywhere under `src/wps/` outside
 * `formats/`, this abstraction is wrong and should be fixed rather than worked
 * around.
 */
export interface WpsFormat {
  /** Stable registry key, persisted in wps_configurations.format. Never rename. */
  readonly key: string;
  readonly displayName: string;
  /** Short prose shown under the format picker in Settings. */
  readonly description: string;

  /** ISO-2 this format applies to. Filters the picker by branch country. */
  readonly country: string;
  /** ISO-4217 the file is denominated in. */
  readonly currency: string;
  /** Minor-unit exponent: OMR/BHD/KWD 3, AED/SAR/QAR 2. */
  readonly currencyExponent: number;

  /**
   * Free-text spec revision, stamped onto every generated WpsFile. When the bank
   * reissues its layout this changes, and every historical file still records
   * which layout it was written against.
   */
  readonly specVersion: string;

  /** Employer registration fields. Drives the Settings form AND the pre-flight. */
  readonly employerConfigSchema: DynamicConfigField[];
  /** Per-run knobs (payment date, purpose code, salary-month convention). */
  readonly runOptionsSchema: DynamicConfigField[];
  /** Employee identifiers this format cannot emit a row without. */
  readonly requiredIdentifiers: WpsIdentifierRequirement[];

  /**
   * Format-specific validation. Pure: no I/O, no DB, no clock.
   *
   * MUST NOT throw for a data problem — a throw is a bug in the adapter, a finding
   * is a problem with the data. Kept separate from generate() so the pre-flight
   * screen can run repeatedly and cheaply without creating a file or a row.
   */
  validate(payload: WpsRunPayload): WpsFinding[];

  /**
   * Produce the file(s). The core guarantees validate() returned no BLOCKING
   * findings first, and re-runs the whole pre-flight itself as a belt-and-braces
   * guard, so an adapter may assume a clean payload — but should still throw
   * rather than emit a malformed row.
   */
  generate(payload: WpsRunPayload): Promise<WpsArtifact[]>;
}

import { FieldDef } from '../common/dynamic-fields/field-def';

/** Where the active template came from. Surfaced for support/debugging. */
export type TemplateSource =
  | 'BRANCH_OVERRIDE'
  | 'COMPANY'
  | 'LEGACY_BASELINE';

/** What the caller is doing, which changes which fields are projected. */
export type TemplateMode = 'CREATE' | 'EDIT' | 'SELF';

/**
 * A template field as the runtime sees it: the shared FieldDef contract plus
 * the storage routing and permission metadata the employee endpoints need.
 */
export interface ResolvedField extends FieldDef {
  id: string | null;
  sectionKey: string;
  storage: 'COLUMN' | 'JSONB';
  boundColumn: string | null;
  defaultValue: string | null;
  colSpan: number;
  visibleToRoles: string[];
  editableByRoles: string[];
  selfVisible: boolean;
  selfEditable: boolean;
  includeInCompletion: boolean;
  isActive: boolean;
  systemDeprecated: boolean;
  origin: 'SYSTEM' | 'CUSTOM';
  /** From EMPLOYEE_BOUND_COLUMNS — the builder renders a lock and this reason. */
  locked: boolean;
  systemRequired: boolean;
  lockReason?: string | null;
}

export interface ResolvedSection {
  id: string | null;
  sectionKey: string;
  label: string;
  icon: string | null;
  wizardStep: number;
  columns: number;
  displayOrder: number;
  fields: ResolvedField[];
}

export interface ResolvedTemplate {
  templateId: string | null;
  source: TemplateSource;
  scope: 'COMPANY' | 'BRANCH' | 'NONE';
  branchId: string | null;
  country: string | null;
  name: string;
  /** Flat list, already filtered by role and active state. Ordering matches sections. */
  fields: ResolvedField[];
  sections: ResolvedSection[];
  /** Reflects the kill switch: false => callers must keep the legacy behaviour. */
  enabled: boolean;
}

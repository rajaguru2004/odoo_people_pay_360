/**
 * Every feature flag has to appear in the settings registry.
 *
 * `getSettingsList()` is a curated array, and it is the ONLY thing
 * `GET /system-settings` returns — so a key missing from it is invisible to the
 * admin UI even though `updateSettings()` will happily write it. The Employee
 * Profile Template shipped in exactly that state: flipping its toggle wrote
 * `true` to the database and the toggle then rendered OFF on every reload,
 * because the read path could not see the key it had just written.
 *
 * A kill switch that misreports its own state is worse than no toggle: an admin
 * who believes the feature is off has no reason to check what it is doing.
 *
 * The drift guard below is the point of this file. Adding a flag without a
 * registry entry is the easy mistake, and it fails silently in the direction
 * that looks like "the toggle is broken" rather than "the feature is live".
 */
import {
  COUNTRY_PRESETS,
  SystemSettingsService,
} from './system-settings.service';

/**
 * Flags whose absence from the registry would make an admin screen lie.
 * Add to this list when you add a kill switch.
 */
const FEATURE_FLAG_KEYS = [
  'employee_template_enabled',
  // ── Document / PDF engine ───────────────────────────────────────────────
  'document_engine_enabled',
  'document_live_preview_enabled',
  'document_bulk_enabled',
  'travel_enabled',
  'training_enabled',
  'pdf_enabled',
  'clearance_blocking_enabled',
  'overtime_enabled',
  // ── Payroll extensions (gap-closure phase) ──────────────────────────────
  'payroll_item_lines_enabled',
  'payroll_eosb_enabled',
  'payroll_eosb_accrual_enabled',
  'payroll_eosb_settlement_enabled',
  'leave_encashment_enabled',
  'leave_carry_forward_enabled',
  'payroll_calendar_enabled',
  'payroll_preflight_enabled',
  'payroll_employee_recovery_enabled',
  'employee_transfer_enabled',
  'employee_grade_enabled',
  'payroll_reports_enabled',
  // Additive engine: a live customer must not have their letters change shape
  // on an upgrade nobody asked for.
  'document_engine_enabled',
  // Renders a real employee's actual pay to whoever is editing a template.
  'document_live_preview_enabled',
  'document_bulk_enabled',
  // A new authoring surface must not appear on an upgrade nobody asked for.
  'document_visual_editor_enabled',
];

/**
 * The payroll-extension flags, which MUST default OFF.
 *
 * Deliberately NOT every key in `FEATURE_FLAG_KEYS`: `overtime_enabled`,
 * `travel_enabled`, `training_enabled`, `pdf_enabled` and
 * `clearance_blocking_enabled` are established features that ship ON, and for those the breaking change would be
 * turning them off. The default a flag must declare depends on whether the
 * feature is already part of the product, not on it being a flag.
 *
 * These are different. A customer is live on the base payroll and every one of
 * these is additive on top of it, so a key that shipped 'true' would change what
 * a running payroll pays on the upgrade that introduced it, with nobody having
 * asked for the change.
 *
 * `payroll_item_lines_strict_reconciliation` is not here either: it defaults
 * 'true' because the safe state for "the lines do not add up" is to refuse, not
 * to proceed quietly. It is pinned in PAYROLL_ENUM_DEFAULTS instead.
 */
const MUST_DEFAULT_OFF = [
  'payroll_item_lines_enabled',
  'payroll_eosb_enabled',
  'payroll_eosb_accrual_enabled',
  'payroll_eosb_settlement_enabled',
  'leave_encashment_enabled',
  'leave_carry_forward_enabled',
  'payroll_calendar_enabled',
  'payroll_preflight_enabled',
  'payroll_employee_recovery_enabled',
  'employee_transfer_enabled',
  'employee_grade_enabled',
  'payroll_reports_enabled',
];

/**
 * Non-boolean settings introduced with the payroll extensions, and the default
 * each must declare. They are listed with their values because the value IS the
 * safe behaviour — `PERIOD_END` is what payroll does today, `WARN` leaves a
 * cut-off advisory, and `BLOCK` refuses to guess an employee's nationality.
 */
const PAYROLL_ENUM_DEFAULTS: Array<[string, string]> = [
  ['payroll_item_lines_strict_reconciliation', 'true'],
  ['payroll_eosb_unknown_nationality_policy', 'BLOCK'],
  ['payroll_eosb_service_year_days', '365'],
  ['leave_encashment_taxable', 'true'],
  ['payroll_cutoff_enforcement', 'WARN'],
  ['payroll_recovery_respects_min_net', 'true'],
  ['payroll_transfer_pay_basis', 'PERIOD_END'],
];

/**
 * Every country preset, so the "defaults OFF" guarantee can be checked against
 * each one. A preset that turns a feature on is the single most likely way one
 * of these ships live by accident, and it would not be visible in
 * `getSettingsList()` at all.
 */
const PRESET_COUNTRIES = ['IN', 'US', 'GB', 'AE', 'OM', 'SG', 'DE', 'CUSTOM'];

function serviceWithNoRows() {
  // getSettingsList() falls back to its declared defaults for every key it
  // cannot find, which is precisely what a fresh database looks like.
  const prisma = { systemSetting: { findMany: jest.fn().mockResolvedValue([]) } };
  const Ctor = SystemSettingsService as unknown as new (
    ...args: any[]
  ) => SystemSettingsService;
  return new Ctor(prisma);
}

describe('system settings registry', () => {
  const list = async () => serviceWithNoRows().getSettingsList();

  it('exposes every feature flag', async () => {
    const keys = new Set((await list()).map((s: any) => s.key));
    const missing = FEATURE_FLAG_KEYS.filter((k) => !keys.has(k));
    expect(missing).toEqual([]);
  });

  it('declares the employee template flag OFF by default', async () => {
    // The whole safety argument for this merge rests on this default. If it
    // ever ships as 'true', the feature is live on upgrade rather than opt-in.
    const row = (await list()).find(
      (s: any) => s.key === 'employee_template_enabled',
    );
    expect(row).toBeDefined();
    expect(row!.value).toBe('false');
  });

  it('describes the employee template flag well enough to act on', async () => {
    const row = (await list()).find(
      (s: any) => s.key === 'employee_template_enabled',
    )!;
    // An admin deciding whether to flip this needs to know what OFF means.
    expect(row.description).toMatch(/off/i);
  });

  it.each(MUST_DEFAULT_OFF)('declares %s OFF by default', async (key) => {
    // Same argument as the employee-template case above, applied to every flag
    // rather than to the one that happened to be written first.
    const row = (await list()).find((s: any) => s.key === key);
    expect(row).toBeDefined();
    expect(row!.value).toBe('false');
  });

  it.each(MUST_DEFAULT_OFF)('describes %s well enough to act on', async (key) => {
    const row = (await list()).find((s: any) => s.key === key)!;
    // An admin deciding whether to flip this needs to know what OFF means.
    expect(row.description).toMatch(/off/i);
  });

  it.each(PAYROLL_ENUM_DEFAULTS)(
    'declares %s defaulting to %s',
    async (key, expected) => {
      const row = (await list()).find((s: any) => s.key === key);
      expect(row).toBeDefined();
      expect(row!.value).toBe(expected);
    },
  );

  it.each(PRESET_COUNTRIES)(
    'the %s country preset turns no payroll feature on',
    (country) => {
      // A preset is a bulk write. If one of these keys appeared in it, applying
      // the preset — something an admin does for unrelated reasons, like
      // switching currency — would silently enable a feature.
      const preset = COUNTRY_PRESETS[country];
      expect(preset).toBeDefined();
      const enabled = MUST_DEFAULT_OFF.filter((k) => k in preset);
      expect(enabled).toEqual([]);
    },
  );

  /**
   * Keys the admin UI reads before it can render a toggle for them.
   *
   * `getPublicSettings()` builds its response from `getAllSettings()`, NOT from
   * `getSettingsList()`. A flag registered only in the curated list is therefore
   * invisible on `/system-settings/public`: the endpoint falls through to its
   * hard-coded default, the screen renders the toggle OFF, and it stays OFF on
   * every reload no matter what was saved. That is the same failure this file's
   * header describes for the employee template — arriving through a second door,
   * which is why it needs its own assertion rather than trust.
   */
  const PUBLICLY_READ_FLAGS = [
    'payroll_item_lines_enabled',
    'payroll_eosb_enabled',
    'payroll_calendar_enabled',
    'payroll_preflight_enabled',
    'payroll_employee_recovery_enabled',
    'leave_encashment_enabled',
    'payroll_reports_enabled',
    'employee_transfer_enabled',
    'employee_grade_enabled',
    // The document engine. Added after exactly the failure this list guards
    // against: the flags were registered in the curated list only, so
    // /system-settings/public never carried them, the branding store fell
    // through to its own `false`, and the Document Templates nav entry could
    // never appear no matter what an admin saved.
    'document_engine_enabled',
    'document_live_preview_enabled',
    'document_bulk_enabled',
    'document_visual_editor_enabled',
  ];

  it.each(PUBLICLY_READ_FLAGS)(
    '%s is declared in getAllSettings too, not only in the curated list',
    async (key) => {
      const all = await serviceWithNoRows().getAllSettings();
      expect(Object.keys(all)).toContain(key);
    },
  );

  it.each(PUBLICLY_READ_FLAGS)(
    '%s actually reaches the /system-settings/public payload (D-24)',
    async (key) => {
      // getAllSettings() declaring the key is NOT the finish line: the public
      // controller builds its payload from a second hand-picked list, so a key
      // present in the service map and absent from the controller is invisible
      // to the branding store — which is exactly how the document flags
      // shipped: registered, saveable, toggling, and never published. This
      // pins the CONTROLLER's payload, the thing the frontend really reads.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { SystemSettingsController } = require('./system-settings.controller');
      const controller = new (SystemSettingsController as unknown as new (
        ...args: any[]
      ) => any)(serviceWithNoRows(), { isEnforced: () => false, isElevated: () => true });
      const res = await controller.getPublicSettings();
      expect(Object.keys(res.data)).toContain(key);
    },
  );

  it.each(PUBLICLY_READ_FLAGS)(
    '%s declares the same default in both structures',
    async (key) => {
      // Two defaults that disagree is worse than one that is missing: the API
      // and the admin screen would each be internally consistent and would
      // still contradict each other.
      const all = await serviceWithNoRows().getAllSettings();
      const row = (await list()).find((s: any) => s.key === key)!;
      expect(all[key]).toBe(row.value);
    },
  );

  it('never lists the same key twice', async () => {
    // A duplicate makes the UI's find() nondeterministic about which default
    // and description it shows.
    const keys = (await list()).map((s: any) => s.key);
    const seen = new Set<string>();
    const dupes = keys.filter((k: string) => {
      if (seen.has(k)) return true;
      seen.add(k);
      return false;
    });
    expect(dupes).toEqual([]);
  });
});

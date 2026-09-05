import { create } from 'zustand';
import axiosInstance from '@/lib/axios';
import { DashboardVersion, normalizeDashboardVersion } from '@/utils/dashboardPreference';

export interface BrandingData {
  company_name: string;
  company_subtitle: string;
  company_logo_url: string;
  company_logo_svg: string;
  company_name_image_url: string;
  company_favicon_url: string;
  office_start_time: string;
  office_end_time: string;
  payroll_work_hours_per_day: string;
  system_timezone: string;
  overtime_enabled: boolean;
  overtime_regular_rate: string;
  overtime_late_rate: string;
  overtime_late_threshold: string;
  overtime_double_ot_enabled: boolean;
  overtime_double_rate: string;
  overtime_sunday_regular_rate: string;
  overtime_sunday_late_rate: string;
  overtime_sunday_late_threshold: string;
  overtime_holiday_regular_rate: string;
  overtime_holiday_late_rate: string;
  overtime_holiday_late_threshold: string;
  overtime_shift_end_time: string;
  overtime_food_allowance_enabled: boolean;
  overtime_food_allowance_amount: string;
  overtime_food_allowance_threshold: string;
  overtime_double_food_allowance_any_time: boolean;
  overtime_double_ot_allow_anytime: boolean;
  /**
   * The approvals screen's review-and-edit affordances. Read `!== false` and
   * `=== true` respectively, matching each key's server default, so the client
   * never offers an action the server would refuse.
   */
  overtime_approver_edit_enabled: boolean;
  overtime_site_allowance_enabled: boolean;
  /** Ceiling for one site allowance. `'0'` means no ceiling. */
  overtime_site_allowance_max: string;
  overtime_max_hours_per_month: string;
  overtime_max_hours_per_year: string;
  overtime_require_reason: boolean;
  attendance_day_end_time: string;
  leave_approval_hierarchy_enabled: boolean;
  reimbursement_enabled: boolean;

  // ── Payroll extensions ──────────────────────────────────────────────
  // Each is additive on top of the base payroll and each defaults OFF, so
  // they are read as `=== true` and never `!== false`: an instance that has
  // never heard of a key must not have the feature switched on for it.
  payroll_item_lines_enabled: boolean;
  payroll_eosb_enabled: boolean;
  /**
   * The two EOSB sub-switches. `FinalSettlementsService` refuses every route
   * unless the master AND the settlement switch are both on, so a screen that
   * read only the master rendered a usable page over a 404ing API.
   *
   * `undefined` on purpose, and it is a THIRD value rather than sloppiness: a
   * backend built before these sub-switches existed does not publish the keys
   * at all — /system-settings/public returns `payroll_eosb_enabled` and
   * nothing else — while its `FinalSettlementsService` gates on the master
   * alone. Coerced to `false` here, the settlement and accrual screens print
   * "switched off" against a server that would have served them, and no
   * amount of flipping the switch in Settings changes it. So absent means
   * "this server has one switch, follow the master", and only an explicit
   * `false` means an admin turned the sub-switch off.
   */
  payroll_eosb_accrual_enabled?: boolean;
  payroll_eosb_settlement_enabled?: boolean;
  payroll_calendar_enabled: boolean;
  payroll_preflight_enabled: boolean;
  /** Ships OFF, so a missing key must read as off rather than as "not fetched". */
  document_engine_enabled: boolean;
  document_visual_editor_enabled: boolean;
  payroll_employee_recovery_enabled: boolean;
  leave_encashment_enabled: boolean;
  payroll_reports_enabled: boolean;
  employee_transfer_enabled: boolean;
  employee_grade_enabled: boolean;
  reimbursement_approver_roles: string;
  reimbursement_types: string;
  advance_loan_enabled: boolean;
  advance_loan_approver_roles: string;
  /** Roles allowed to write off a loan balance; gates the action in the UI. */
  advance_loan_writeoff_roles: string;
  advance_loan_max_installments: string;
  /** Whether interest terms may be offered on the request form at all. */
  loan_interest_enabled: boolean;
  advance_max_percent_of_salary: string;
  theme_preset: string;
  theme_font: string;
  theme_custom_colors: string;      // JSON: { brandPrimary, brandPrimaryDark, ... }
  theme_custom_font_family: string; // Google Font family name (e.g. "Roboto Slab")
  theme_custom_font_url: string;    // Optional full stylesheet URL override
  geofencing_enabled: boolean;
  dashboard_layout: DashboardVersion;
}

interface BrandingState {
  branding: BrandingData;
  /**
   * Whether `branding` is an ANSWER or still the hardcoded defaults.
   *
   * Load-bearing, and its absence was a real defect: the initial state has
   * every feature flag `false`, and `isLoading` starts `false` too — so a
   * screen could not tell "settings were read and this feature is off" from
   * "settings have not been read yet". All nine payroll extension screens
   * therefore printed "switched off" as a statement of fact during the window
   * before the first `/system-settings/public` response, and after any failed
   * read. Turning a feature on and being told it is off is the exact user
   * report this exists to prevent.
   */
  loaded: boolean;
  isLoading: boolean;
  error: string | null;
  fetchBranding: () => Promise<void>;
  updateBrandingState: (newData: Partial<BrandingData>) => void;
}

export const useBrandingStore = create<BrandingState>((set) => ({
  branding: {
    company_name: 'The Company',
    company_subtitle: 'TRS ADMIN',
    company_logo_url: '',
    company_logo_svg: '',
    company_name_image_url: '',
    company_favicon_url: '',
    office_start_time: '08:30',
    office_end_time: '17:30',
    payroll_work_hours_per_day: '8',
    system_timezone: 'Asia/Kolkata',
    overtime_enabled: true,
    overtime_regular_rate: '1.5',
    overtime_late_rate: '1.5',
    overtime_late_threshold: '22:00',
    overtime_double_ot_enabled: true,
    overtime_double_rate: '2.0',
    overtime_sunday_regular_rate: '2.0',
    overtime_sunday_late_rate: '2.0',
    overtime_sunday_late_threshold: '22:00',
    overtime_holiday_regular_rate: '2.0',
    overtime_holiday_late_rate: '2.0',
    overtime_holiday_late_threshold: '22:00',
    overtime_shift_end_time: '17:00',
    overtime_food_allowance_enabled: true,
    overtime_food_allowance_amount: '150',
    overtime_food_allowance_threshold: '22:00',
    overtime_double_food_allowance_any_time: false,
    overtime_double_ot_allow_anytime: true,
    overtime_approver_edit_enabled: true,
    overtime_site_allowance_enabled: false,
    overtime_site_allowance_max: '0',
    overtime_max_hours_per_month: '30',
    overtime_max_hours_per_year: '200',
    overtime_require_reason: true,
    attendance_day_end_time: '23:59',
    leave_approval_hierarchy_enabled: false,
    reimbursement_enabled: true,
    payroll_item_lines_enabled: false,
    payroll_eosb_enabled: false,
    // Left unset, not false — see the type. `loaded` is what tells a screen
    // the answer has not arrived yet.
    payroll_eosb_accrual_enabled: undefined,
    payroll_eosb_settlement_enabled: undefined,
    payroll_calendar_enabled: false,
    payroll_preflight_enabled: false,
    document_engine_enabled: false,
    document_visual_editor_enabled: false,
    payroll_employee_recovery_enabled: false,
    leave_encashment_enabled: false,
    payroll_reports_enabled: false,
    employee_transfer_enabled: false,
    employee_grade_enabled: false,
    reimbursement_approver_roles: 'HR_MANAGER,ADMIN',
    reimbursement_types: 'Travel,Medical,Food,Office Supplies,Other',
    advance_loan_enabled: true,
    advance_loan_approver_roles: 'HR_MANAGER,ADMIN',
    advance_loan_writeoff_roles: 'ADMIN',
    advance_loan_max_installments: '12',
    loan_interest_enabled: false,
    advance_max_percent_of_salary: '100',
    theme_preset: 'default',
    theme_font: 'montserrat',
    theme_custom_colors: '',
    theme_custom_font_family: '',
    theme_custom_font_url: '',
    geofencing_enabled: false,
    dashboard_layout: 'v2',
  },
  loaded: false,
  isLoading: false,
  error: null,
  fetchBranding: async () => {
    try {
      set({ isLoading: true });
      const res: any = await axiosInstance.get('/system-settings/public');
      if (res?.success && res?.data) {
        set({
          branding: {
            company_name: res.data.company_name || 'The Company',
            company_subtitle: res.data.company_subtitle || 'TRS ADMIN',
            company_logo_url: res.data.company_logo_url || '',
            company_logo_svg: res.data.company_logo_svg || '',
            company_name_image_url: res.data.company_name_image_url || '',
            company_favicon_url: res.data.company_favicon_url || '',
            office_start_time: res.data.office_start_time || '08:30',
            office_end_time: res.data.office_end_time || '17:30',
            payroll_work_hours_per_day: res.data.payroll_work_hours_per_day || '8',
            system_timezone: res.data.system_timezone || 'Asia/Kolkata',
            overtime_enabled: res.data.overtime_enabled !== false,
            overtime_regular_rate: res.data.overtime_regular_rate || '1.5',
            overtime_late_rate: res.data.overtime_late_rate || '1.5',
            overtime_late_threshold: res.data.overtime_late_threshold || '22:00',
            overtime_double_ot_enabled: res.data.overtime_double_ot_enabled !== false,
            overtime_double_rate: res.data.overtime_double_rate || '2.0',
            overtime_sunday_regular_rate: res.data.overtime_sunday_regular_rate || res.data.overtime_double_rate || '2.0',
            overtime_sunday_late_rate: res.data.overtime_sunday_late_rate || res.data.overtime_double_rate || '2.0',
            overtime_sunday_late_threshold: res.data.overtime_sunday_late_threshold || res.data.overtime_late_threshold || '22:00',
            overtime_holiday_regular_rate: res.data.overtime_holiday_regular_rate || res.data.overtime_double_rate || '2.0',
            overtime_holiday_late_rate: res.data.overtime_holiday_late_rate || res.data.overtime_double_rate || '2.0',
            overtime_holiday_late_threshold: res.data.overtime_holiday_late_threshold || res.data.overtime_late_threshold || '22:00',
            overtime_shift_end_time: res.data.overtime_shift_end_time || '17:00',
            overtime_food_allowance_enabled: res.data.overtime_food_allowance_enabled !== false,
            overtime_food_allowance_amount: res.data.overtime_food_allowance_amount || '150',
            overtime_food_allowance_threshold: res.data.overtime_food_allowance_threshold || res.data.overtime_late_threshold || '22:00',
            overtime_double_food_allowance_any_time: res.data.overtime_double_food_allowance_any_time === true,
            overtime_double_ot_allow_anytime: res.data.overtime_double_ot_allow_anytime !== false,
            overtime_approver_edit_enabled: res.data.overtime_approver_edit_enabled !== false,
            overtime_site_allowance_enabled: res.data.overtime_site_allowance_enabled === true,
            overtime_site_allowance_max: res.data.overtime_site_allowance_max || '0',
            overtime_max_hours_per_month: res.data.overtime_max_hours_per_month || '30',
            overtime_max_hours_per_year: res.data.overtime_max_hours_per_year || '200',
            overtime_require_reason: res.data.overtime_require_reason !== false,
            attendance_day_end_time: res.data.attendance_day_end_time || '23:59',
            leave_approval_hierarchy_enabled: res.data.leave_approval_hierarchy_enabled === true,
            reimbursement_enabled: res.data.reimbursement_enabled !== false,
            payroll_item_lines_enabled: res.data.payroll_item_lines_enabled === true,
            payroll_eosb_enabled: res.data.payroll_eosb_enabled === true,
            // Boolean-or-undefined, deliberately not `=== true`: the
            // difference between a server that published `false` and one that
            // has never heard of the key is the whole point of these two. Any
            // non-boolean (a string, a null) still reads as "not published".
            payroll_eosb_accrual_enabled:
              typeof res.data.payroll_eosb_accrual_enabled === 'boolean'
                ? res.data.payroll_eosb_accrual_enabled
                : undefined,
            payroll_eosb_settlement_enabled:
              typeof res.data.payroll_eosb_settlement_enabled === 'boolean'
                ? res.data.payroll_eosb_settlement_enabled
                : undefined,
            payroll_calendar_enabled: res.data.payroll_calendar_enabled === true,
            payroll_preflight_enabled: res.data.payroll_preflight_enabled === true,
            // `=== true`, not `!== false`: this feature ships OFF, so an older
            // backend that does not send the key must hide it rather than
            // surface a screen whose API answers 404.
            document_engine_enabled: res.data.document_engine_enabled === true,
            document_visual_editor_enabled: res.data.document_visual_editor_enabled === true,
            payroll_employee_recovery_enabled: res.data.payroll_employee_recovery_enabled === true,
            leave_encashment_enabled: res.data.leave_encashment_enabled === true,
            payroll_reports_enabled: res.data.payroll_reports_enabled === true,
            employee_transfer_enabled: res.data.employee_transfer_enabled === true,
            employee_grade_enabled: res.data.employee_grade_enabled === true,
            reimbursement_approver_roles: res.data.reimbursement_approver_roles || 'HR_MANAGER,ADMIN',
            reimbursement_types: res.data.reimbursement_types || 'Travel,Medical,Food,Office Supplies,Other',
            advance_loan_enabled: res.data.advance_loan_enabled !== false,
            advance_loan_approver_roles: res.data.advance_loan_approver_roles || 'HR_MANAGER,ADMIN',
            advance_loan_writeoff_roles: res.data.advance_loan_writeoff_roles || 'ADMIN',
            advance_loan_max_installments: res.data.advance_loan_max_installments || '12',
            advance_max_percent_of_salary: res.data.advance_max_percent_of_salary || '100',
            // Defaults FALSE when the server does not publish it: offering an
            // interest field the server would refuse is worse than hiding one
            // it would have honoured.
            loan_interest_enabled: res.data.loan_interest_enabled === true,
            theme_preset: res.data.theme_preset || 'default',
            theme_font: res.data.theme_font || 'montserrat',
            theme_custom_colors: res.data.theme_custom_colors || '',
            theme_custom_font_family: res.data.theme_custom_font_family || '',
            theme_custom_font_url: res.data.theme_custom_font_url || '',
            geofencing_enabled: res.data.geofencing_enabled === true,
            dashboard_layout: normalizeDashboardVersion(res.data.dashboard_layout),
          },
          error: null,
          // Only on a SUCCESSFUL read. A failed fetch leaves the defaults in
          // place, and defaults are not an answer — a screen must not report
          // "this feature is switched off" on the strength of them.
          loaded: true,
        });
      }
    } catch (err: any) {
      console.error('Failed to fetch branding settings:', err);
      // Keep defaults on failure
      set({ error: err?.message || 'Failed to load branding' });
    } finally {
      set({ isLoading: false });
    }
  },
  updateBrandingState: (newData) => {
    set((state) => ({
      branding: {
        ...state.branding,
        ...newData,
      },
    }));
  },
}));

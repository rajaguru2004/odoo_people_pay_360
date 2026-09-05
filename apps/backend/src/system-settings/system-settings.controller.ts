import {
  Controller,
  Get,
  Post,
  Body,
  ForbiddenException,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { SystemSettingsService } from './system-settings.service';
import { isProtectedSettingKey } from './protected-setting-keys';
import { isDeveloperSettingKey } from './developer-setting-keys';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { ResetDatabaseDto } from './dto/reset-database.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditResource } from '../audit/audit-resource.decorator';
import { DevModeGuard } from '../dev-mode/dev-mode.guard';
import { DevModeService } from '../dev-mode/dev-mode.service';
import { RequireDeveloper } from '../dev-mode/require-developer.decorator';

@ApiTags('System Settings')
@Controller('system-settings')
@UseGuards(JwtAuthGuard, RolesGuard, DevModeGuard)
@ApiBearerAuth('JWT-auth')
// Settings writes were previously unaudited — a silent change to payroll rates
// or a database reset left no trace at all.
@AuditResource('SystemSetting')
export class SystemSettingsController {
  constructor(
    private readonly settingsService: SystemSettingsService,
    private readonly devMode: DevModeService,
  ) {}

  @Get('public')
  @Public()
  @ApiOperation({ summary: 'Get public system branding settings' })
  @ApiResponse({ status: 200, description: 'Branding retrieved successfully' })
  async getPublicSettings() {
    let s: Record<string, string>;
    try {
      s = await this.settingsService.getAllSettings();
    } catch {
      s = {};
    }

    const g = (key: string, def: string) => s[key] ?? def;

    return {
      success: true,
      data: {
        company_name: g('company_name', 'The Company'),
        company_subtitle: g('company_subtitle', 'TRS ADMIN'),
        company_logo_url: g('company_logo_url', ''),
        company_logo_svg: g('company_logo_svg', ''),
        company_name_image_url: g('company_name_image_url', ''),
        company_favicon_url: g('company_favicon_url', ''),
        office_start_time: g('office_start_time', '08:30'),
        office_end_time: g('office_end_time', '17:30'),
        lunch_break_start: g('lunch_break_start', '13:00'),
        lunch_break_duration_minutes: g('lunch_break_duration_minutes', '60'),
        payroll_work_hours_per_day: g('payroll_work_hours_per_day', '8'),
        system_timezone: g('system_timezone', 'Asia/Kolkata'),
        calendar_weekly_holidays: g('calendar_weekly_holidays', '0'),
        payroll_country: g('payroll_country', 'IN'),
        payroll_currency: g('payroll_currency', 'INR'),
        payroll_currency_symbol: g('payroll_currency_symbol', '₹'),
        payroll_currency_display: g('payroll_currency_display', 'symbol'),
        payroll_label_pf: g('payroll_label_pf', ''),
        payroll_label_income_tax: g('payroll_label_income_tax', ''),
        payroll_pf_enabled: g('payroll_pf_enabled', 'true'),
        payroll_pf_employee_rate: g('payroll_pf_employee_rate', '0.12'),
        payroll_pf_salary_cap: g('payroll_pf_salary_cap', '15000'),
        payroll_esi_enabled: g('payroll_esi_enabled', 'true'),
        payroll_esi_employee_rate: g('payroll_esi_employee_rate', '0.0075'),
        payroll_esi_salary_cap: g('payroll_esi_salary_cap', '21000'),
        payroll_tax_regime: g('payroll_tax_regime', 'new'),
        payroll_standard_deduction: g('payroll_standard_deduction', '75000'),
        payroll_tax_rebate_enabled: g('payroll_tax_rebate_enabled', 'true'),
        payroll_tax_rebate_limit: g('payroll_tax_rebate_limit', '700000'),
        payroll_cess_enabled: g('payroll_cess_enabled', 'true'),
        payroll_cess_rate: g('payroll_cess_rate', '0.04'),
        face_recognition_enabled: g('face_recognition_enabled', 'true'),
        overtime_enabled: g('overtime_enabled', 'true') === 'true',
        overtime_regular_rate: g('overtime_regular_rate', '1.5'),
        overtime_late_rate: g('overtime_late_rate', '1.5'),
        overtime_late_threshold: g('overtime_late_threshold', '22:00'),
        overtime_double_ot_enabled:
          g('overtime_double_ot_enabled', 'true') === 'true',
        overtime_double_rate: g('overtime_double_rate', '2.0'),
        overtime_sunday_regular_rate: g(
          'overtime_sunday_regular_rate',
          g('overtime_double_rate', '2.0'),
        ),
        overtime_sunday_late_rate: g(
          'overtime_sunday_late_rate',
          g('overtime_double_rate', '2.0'),
        ),
        overtime_sunday_late_threshold: g(
          'overtime_sunday_late_threshold',
          g('overtime_late_threshold', '22:00'),
        ),
        overtime_holiday_regular_rate: g(
          'overtime_holiday_regular_rate',
          g('overtime_double_rate', '2.0'),
        ),
        overtime_holiday_late_rate: g(
          'overtime_holiday_late_rate',
          g('overtime_double_rate', '2.0'),
        ),
        overtime_holiday_late_threshold: g(
          'overtime_holiday_late_threshold',
          g('overtime_late_threshold', '22:00'),
        ),
        overtime_shift_end_time: g('overtime_shift_end_time', '17:00'),
        overtime_food_allowance_enabled:
          g('overtime_food_allowance_enabled', 'true') === 'true',
        overtime_food_allowance_amount: g(
          'overtime_food_allowance_amount',
          '150',
        ),
        overtime_food_allowance_threshold: g(
          'overtime_food_allowance_threshold',
          g('overtime_late_threshold', '22:00'),
        ),
        overtime_double_food_allowance_any_time:
          g('overtime_double_food_allowance_any_time', 'false') === 'true',
        // The review-and-edit affordances on the approvals screen: the client
        // hides the editor and the site-allowance toggle when these are off, so
        // it never offers an action the server will refuse.
        overtime_approver_edit_enabled:
          g('overtime_approver_edit_enabled', 'true') === 'true',
        overtime_site_allowance_enabled:
          g('overtime_site_allowance_enabled', 'false') === 'true',
        overtime_site_allowance_max: g('overtime_site_allowance_max', '0'),
        overtime_double_ot_allow_anytime:
          g('overtime_double_ot_allow_anytime', 'true') === 'true',
        overtime_max_hours_per_month: g('overtime_max_hours_per_month', '30'),
        overtime_max_hours_per_year: g('overtime_max_hours_per_year', '200'),
        overtime_require_reason:
          g('overtime_require_reason', 'true') === 'true',
        leave_approval_hierarchy_enabled:
          g('leave_approval_hierarchy_enabled', 'false') === 'true',
        supervisor_approval_enabled:
          g('supervisor_approval_enabled', 'false') === 'true',

        // Payroll extensions. Every one defaults to the string 'false', so an
        // instance that has never heard of them reads them off. Emitted as real
        // booleans, following overtime_enabled rather than the string style of
        // the payroll_pf_* keys, because the sidebar and the payslip renderer
        // branch on them directly.
        payroll_item_lines_enabled:
          g('payroll_item_lines_enabled', 'false') === 'true',
        payroll_eosb_enabled: g('payroll_eosb_enabled', 'false') === 'true',
        // The two sub-switches, and they are load-bearing rather than
        // decorative: `FinalSettlementsService.assertEnabled()` refuses every
        // route unless eosb AND settlement are both on, so a screen that gated
        // on the master alone rendered a complete, usable settlements page over
        // an API answering 404 to all of it.
        payroll_eosb_accrual_enabled:
          g('payroll_eosb_accrual_enabled', 'false') === 'true',
        payroll_eosb_settlement_enabled:
          g('payroll_eosb_settlement_enabled', 'false') === 'true',
        payroll_eosb_pay_through_final_run:
          g('payroll_eosb_pay_through_final_run', 'false') === 'true',
        payroll_calendar_enabled:
          g('payroll_calendar_enabled', 'false') === 'true',
        payroll_preflight_enabled:
          g('payroll_preflight_enabled', 'false') === 'true',
        payroll_employee_recovery_enabled:
          g('payroll_employee_recovery_enabled', 'false') === 'true',
        leave_encashment_enabled:
          g('leave_encashment_enabled', 'false') === 'true',
        payroll_reports_enabled:
          g('payroll_reports_enabled', 'false') === 'true',
        employee_transfer_enabled:
          g('employee_transfer_enabled', 'false') === 'true',
        employee_grade_enabled: g('employee_grade_enabled', 'false') === 'true',
        // The document engine flags. Declaring them in getAllSettings() is NOT
        // enough — this payload is a hand-picked list, so a flag missing HERE
        // never reaches the branding store and its nav entry / conversion
        // banner stays hidden forever, whatever an admin saves. That exact
        // failure shipped once already (D-24); the registry spec now pins
        // every PUBLICLY_READ_FLAG against this controller method.
        document_engine_enabled:
          g('document_engine_enabled', 'false') === 'true',
        document_visual_editor_enabled:
          g('document_visual_editor_enabled', 'false') === 'true',
        document_live_preview_enabled:
          g('document_live_preview_enabled', 'false') === 'true',
        document_bulk_enabled: g('document_bulk_enabled', 'false') === 'true',
        strict_attendance_mode: g('strict_attendance_mode', 'false') === 'true',
        attendance_day_end_time: g('attendance_day_end_time', '23:59'),
        geofencing_enabled: g('geofencing_enabled', 'false') === 'true',
        theme_preset: g('theme_preset', 'default'),
        theme_font: g('theme_font', 'montserrat'),
        theme_custom_colors: g('theme_custom_colors', ''),
        theme_custom_font_family: g('theme_custom_font_family', ''),
        theme_custom_font_url: g('theme_custom_font_url', ''),
        dashboard_layout: g('dashboard_layout', 'v2'),
        // Published so onboarding forms can bound their date pickers. Read from
        // the PUBLIC endpoint on purpose: GET /system-settings is limited to
        // ADMIN/HR_MANAGER/MANAGER and the wizard must not break for anyone else.
        employee_start_date_max_past_days: g(
          'employee_start_date_max_past_days',
          '',
        ),
        employee_start_date_max_future_days: g(
          'employee_start_date_max_future_days',
          '180',
        ),
        employee_start_date_floor: g('employee_start_date_floor', '1970-01-01'),
      },
    };
  }

  @Get()
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({ summary: 'Get all system settings' })
  @ApiResponse({ status: 200, description: 'Settings retrieved successfully' })
  async getSettings(@CurrentUser() user: any, @Req() req: any) {
    const list = await this.settingsService.getSettingsList();

    // Operator-owned keys (SMTP, copilot.*) are REMOVED rather than
    // masked when the caller has not stepped up into developer mode. Masking
    // would still disclose that they exist, and the point of developer mode is
    // that an admin cannot tell the hidden surface is there at all.
    const hideDeveloperKeys =
      this.devMode.isEnforced() && !this.devMode.isElevated(req);
    const visible = hideDeveloperKeys
      ? list.filter((item) => !isDeveloperSettingKey(item.key))
      : list;

    // Secret-bearing keys are masked for EVERY role, not just MANAGER, and the
    // mask is never lifted by elevation. Integration credentials have dedicated
    // admin endpoints that return a boolean plus a masked hint; there is no
    // reason for the generic settings dump to carry them, even as ciphertext.
    const masked = visible.map((item) =>
      isProtectedSettingKey(item.key) ? { ...item, value: '********' } : item,
    );

    // Mail transport config additionally stays hidden from MANAGER.
    if (user?.role === 'MANAGER') {
      const sensitiveKeys = [
        'mail_host',
        'mail_port',
        'mail_user',
        'mail_password',
        'mail_from',
        'mail_from_name',
        'mail_bcc',
      ];
      const sanitizedList = masked.map((item) => {
        if (sensitiveKeys.includes(item.key)) {
          return {
            ...item,
            value: '********',
          };
        }
        return item;
      });
      return {
        success: true,
        data: sanitizedList,
      };
    }

    return {
      success: true,
      data: masked,
    };
  }

  @Post()
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Update system settings (Admin only)' })
  @ApiResponse({ status: 200, description: 'Settings updated successfully' })
  // A key with a declared shape (enum, percent, non-negative number, role list,
  // boolean) is checked before anything is written, and the whole payload is
  // refused if any of them fails. Keys with no declared shape still pass
  // through — other modules store their own configuration here.
  @ApiResponse({
    status: 400,
    description:
      'A setting value does not match the shape its key accepts; the message names the key and the accepted values. Nothing was written.',
  })
  async updateSettings(
    @Body() updateSettingsDto: UpdateSettingsDto,
    @Req() req: any,
  ) {
    // Partial gate: one payload may legitimately mix tenant keys with operator
    // keys, so this cannot be a route-level @RequireDeveloper(). Reject the
    // whole request rather than silently dropping the developer keys — a
    // half-applied save is worse than a refused one.
    if (this.devMode.isEnforced() && !this.devMode.isElevated(req)) {
      const blocked = Object.keys(updateSettingsDto.settings ?? {}).filter(
        isDeveloperSettingKey,
      );
      if (blocked.length > 0) {
        // Name the keys. The bare "no access" message made a client that simply
        // resubmits its whole form indistinguishable from a real privilege
        // probe, and left the admin with a 403 on an unrelated save and nothing
        // to act on. The key NAMES are not the secret here — their values are,
        // and those are still neither readable nor writable.
        throw new ForbiddenException(
          `You do not have access to these settings: ${blocked.join(', ')}`,
        );
      }
    }

    return this.settingsService.updateSettings(updateSettingsDto.settings);
  }

  @Post('apply-preset')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Apply a country payroll preset (Admin only)',
    description:
      'Resets all payroll-related system settings to the defaults for the given country. ' +
      'Supported presets: IN (India), US (USA), GB (UK), AE (UAE), OM (Oman), SG (Singapore), DE (Germany), CUSTOM (blank slate).',
  })
  @ApiResponse({ status: 200, description: 'Preset applied successfully' })
  async applyPreset(@Body() body: { preset: string }) {
    const supported = ['IN', 'US', 'GB', 'AE', 'OM', 'SG', 'DE', 'CUSTOM'];
    const code = (body.preset ?? '').toUpperCase();
    if (!supported.includes(code)) {
      return {
        success: false,
        message: `Unknown preset: ${body.preset}. Supported presets: ${supported.join(', ')}`,
      };
    }
    return this.settingsService.applyCountryPreset(code);
  }

  @Post('reset')
  @Roles('ADMIN')
  // Wiping a live tenant is an operator action, never a customer-admin one.
  @RequireDeveloper()
  @ApiOperation({
    summary: 'Reset database to baseline (developer mode only)',
    description:
      'DESTRUCTIVE. Permanently deletes all operational data (employees, users, ' +
      'attendance, payroll, leave, etc.) and restores only the base ' +
      'admin/HR/employee accounts, the HRD department and an active Head Office ' +
      'branch. System settings, libraries and holidays are preserved. Requires ' +
      'a confirmation body { "confirm": "RESET" }.',
  })
  @ApiResponse({ status: 200, description: 'Database reset to baseline' })
  async resetDatabase(
    @Body() _dto: ResetDatabaseDto,
    @CurrentUser() user: any,
  ) {
    return this.settingsService.resetToBaseline({
      id: user?.id,
      email: user?.email,
    });
  }
}

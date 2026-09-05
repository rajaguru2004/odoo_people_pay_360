import { isDeveloperSettingKey } from './developer-setting-keys';
import { isProtectedSettingKey } from './protected-setting-keys';

/**
 * The two key filters are separate axes and both are applied to
 * GET /system-settings. This pins which keys fall on which axis, because getting
 * it wrong is silent: a miss leaks operator config to every tenant admin, and an
 * over-match hides ordinary settings the admin needs.
 */
describe('isDeveloperSettingKey', () => {
  it('covers every mail transport key', () => {
    for (const key of [
      'mail_enabled',
      'mail_host',
      'mail_port',
      'mail_user',
      'mail_password',
      'mail_from',
      'mail_from_name',
      'mail_bcc',
    ]) {
      expect(isDeveloperSettingKey(key)).toBe(true);
    }
  });

  it('covers copilot and whatsapp keys by prefix, including ones not yet written', () => {
    expect(isDeveloperSettingKey('copilot.enabled')).toBe(true);
    expect(isDeveloperSettingKey('copilot.llmBaseUrl')).toBe(true);
    expect(isDeveloperSettingKey('copilot.somethingAddedNextYear')).toBe(true);
    expect(isDeveloperSettingKey('whatsapp.enabled')).toBe(true);
    expect(isDeveloperSettingKey('whatsapp.instanceName')).toBe(true);
  });

  it('covers the employee-field template switch', () => {
    expect(isDeveloperSettingKey('employee_template_enabled')).toBe(true);
  });

  it('leaves tenant-owned settings alone', () => {
    for (const key of [
      'company_name',
      'payroll_currency',
      'payroll_pf_enabled',
      'overtime_enabled',
      'office_start_time',
      'theme_preset',
      'reimbursement_enabled',
      'supervisor_approval_enabled',
      'attendance_day_end_time',
    ]) {
      expect(isDeveloperSettingKey(key)).toBe(false);
    }
  });

  it('does not catch unrelated keys that merely contain "mail"', () => {
    // Prefix rule, not substring — `employee_email_alerts` is tenant config.
    expect(isDeveloperSettingKey('employee_email_alerts')).toBe(false);
  });
});

describe('developer vs protected are independent axes', () => {
  it('mail_password is developer-owned but NOT protected — which is why it used to be readable', () => {
    expect(isDeveloperSettingKey('mail_password')).toBe(true);
    expect(isProtectedSettingKey('mail_password')).toBe(false);
  });

  it('the copilot API key is both: hidden from admins AND masked even when elevated', () => {
    expect(isDeveloperSettingKey('copilot.llmApiKeyEnc')).toBe(true);
    expect(isProtectedSettingKey('copilot.llmApiKeyEnc')).toBe(true);
  });
});

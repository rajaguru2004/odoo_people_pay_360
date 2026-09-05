'use client';

import { useMemo } from 'react';
import { Building2, Globe, Palette } from 'lucide-react';
import { Select } from '@/components/ui/Select';
import { CURRENCY_DECIMALS } from '@/utils/constants';
import {
  ColorInput,
  Field,
  SectionCard,
  SettingInput,
  SettingNotice,
} from './SettingsPrimitives';

/** The keys this section owns. The save bar patches exactly these. */
export const BRANDING_KEYS = [
  'company_name',
  'company_short_name',
  'company_logo_url',
  'primary_color',
  'accent_color',
  'default_currency',
  'default_timezone',
] as const;

const CURRENCIES = Object.keys(CURRENCY_DECIMALS).sort();

/**
 * The IANA zones this browser knows, with the configured value forced in.
 *
 * `Intl.supportedValuesOf` is the whole list and needs no maintenance, but an
 * older engine may not have it and a saved zone may not be in the list — either
 * would silently reset the field to the first option on the next save.
 */
function useTimezones(current: string) {
  return useMemo(() => {
    let zones: string[] = [];
    try {
      zones = Intl.supportedValuesOf?.('timeZone') ?? [];
    } catch {
      zones = [];
    }
    if (current && !zones.includes(current)) zones = [current, ...zones];
    return zones;
  }, [current]);
}

export function BrandingSection({
  values,
  onChange,
  disabled,
}: {
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  disabled?: boolean;
}) {
  const timezone = values.default_timezone ?? '';
  const timezones = useTimezones(timezone);
  const logoUrl = values.company_logo_url ?? '';

  return (
    <div className="space-y-4 sm:space-y-5">
      <SectionCard
        title="Company identity"
        description="The name and mark shown in the sidebar, the browser tab and on every document the system issues"
        icon={Building2}
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Company name">
            {(id) => (
              <SettingInput
                id={id}
                value={values.company_name ?? ''}
                onChange={(value) => onChange('company_name', value)}
                placeholder="People Pay 360"
                disabled={disabled}
              />
            )}
          </Field>

          <Field
            label="Short name"
            hint="Used where the full name will not fit, and as the fallback when the logo cannot be loaded."
          >
            {(id) => (
              <SettingInput
                id={id}
                value={values.company_short_name ?? ''}
                onChange={(value) => onChange('company_short_name', value)}
                placeholder="PP360"
                disabled={disabled}
              />
            )}
          </Field>

          <Field
            label="Logo URL"
            className="md:col-span-2"
            hint="Any image the browser can load — PNG, JPG, SVG or WebP."
          >
            {(id) => (
              <SettingInput
                id={id}
                type="url"
                value={logoUrl}
                onChange={(value) => onChange('company_logo_url', value)}
                placeholder="https://example.com/logo.png"
                disabled={disabled}
              />
            )}
          </Field>
        </div>

        {logoUrl && (
          <div className="flex items-center gap-3 rounded-[var(--radius-card)] border border-surface-border-light bg-surface-page p-3">
            {/* Arbitrary remote host, so `next/image` would need every one of
                them in the config. A plain img is the only thing that works for
                a URL an administrator pastes. */}
            <img
              src={logoUrl}
              alt={`${values.company_name || 'Company'} logo`}
              className="h-10 w-auto max-w-40 object-contain"
            />
            <p className="text-xs text-text-muted">
              How the mark appears in the sidebar. A broken image here is a URL the
              browser cannot reach.
            </p>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Colours"
        description="Applied across the portal once saved"
        icon={Palette}
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field
            label="Primary colour"
            hint="The brand colour: primary buttons, active navigation and links."
          >
            {(id) => (
              <ColorInput
                id={id}
                value={values.primary_color ?? ''}
                onChange={(value) => onChange('primary_color', value)}
                disabled={disabled}
              />
            )}
          </Field>

          <Field
            label="Accent colour"
            hint="The secondary emphasis colour, used for highlights beside the primary."
          >
            {(id) => (
              <ColorInput
                id={id}
                value={values.accent_color ?? ''}
                onChange={(value) => onChange('accent_color', value)}
                disabled={disabled}
              />
            )}
          </Field>
        </div>
      </SectionCard>

      <SectionCard
        title="Locale"
        description="The currency amounts are quoted in and the zone times are read in"
        icon={Globe}
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field
            label="Default currency"
            hint="Decides how many decimal places money is shown to — the Gulf thousandths currencies take three, not two."
          >
            {(id) => (
              <Select
                id={id}
                value={values.default_currency ?? ''}
                disabled={disabled}
                onChange={(event) => onChange('default_currency', event.target.value)}
              >
                {CURRENCIES.map((code) => (
                  <option key={code} value={code}>
                    {code} · {CURRENCY_DECIMALS[code]} decimal
                    {CURRENCY_DECIMALS[code] === 1 ? '' : 's'}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field
            label="Default timezone"
            hint="Office hours and attendance boundaries are wall-clock times in this zone."
          >
            {(id) => (
              <Select
                id={id}
                value={timezone}
                disabled={disabled}
                onChange={(event) => onChange('default_timezone', event.target.value)}
              >
                {timezones.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <SettingNotice>
          Changing the timezone re-reads every stored punch against the new zone. A
          shift that spanned midnight in the old one may land on a different day.
        </SettingNotice>
      </SectionCard>
    </div>
  );
}

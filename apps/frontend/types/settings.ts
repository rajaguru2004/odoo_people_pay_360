/** The unauthenticated branding payload served by GET /system-settings/public. */
export interface PublicBranding {
  company_name: string;
  company_short_name: string;
  company_logo_url?: string;
  primary_color: string;
  accent_color: string;
  default_currency: string;
  default_timezone: string;
  /** Theme selections, when an admin has saved them. */
  theme_preset?: string;
  theme_font?: string;
  theme_custom_colors?: string;
  theme_custom_font_family?: string;
  theme_custom_font_url?: string;
}

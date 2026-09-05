/**
 * ─────────────────────────────────────────────────────────────────────────────
 * FONT REGISTRY
 * ─────────────────────────────────────────────────────────────────────────────
 * Selectable body fonts. The Settings "Theme & Appearance" picker renders each
 * label in its own font; the resolver overrides the active theme's
 * typography.fontSans / googleFontsUrl with the chosen font.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface ThemeFont {
  id: string;
  label: string;
  /** CSS font-family stack applied to --font-brand-sans. */
  fontStack: string;
  /** Google Fonts stylesheet URL injected at runtime. */
  googleFontsUrl: string;
}

const g = (family: string, weights = '300;400;500;600;700;800') =>
  `https://fonts.googleapis.com/css2?family=${family}:wght@${weights}&display=swap`;

export const THEME_FONTS: ThemeFont[] = [
  {
    id: 'montserrat',
    label: 'Montserrat',
    fontStack: '"Montserrat", sans-serif',
    googleFontsUrl: g('Montserrat'),
  },
  {
    id: 'inter',
    label: 'Inter',
    fontStack: '"Inter", system-ui, -apple-system, sans-serif',
    googleFontsUrl: g('Inter', '400;500;600;700;800'),
  },
  {
    id: 'poppins',
    label: 'Poppins',
    fontStack: '"Poppins", sans-serif',
    googleFontsUrl: g('Poppins', '300;400;500;600;700'),
  },
  {
    id: 'roboto',
    label: 'Roboto',
    fontStack: '"Roboto", sans-serif',
    googleFontsUrl: g('Roboto', '300;400;500;700;900'),
  },
  {
    id: 'open-sans',
    label: 'Open Sans',
    fontStack: '"Open Sans", sans-serif',
    googleFontsUrl: g('Open+Sans', '400;500;600;700;800'),
  },
  {
    id: 'lato',
    label: 'Lato',
    fontStack: '"Lato", sans-serif',
    googleFontsUrl: g('Lato', '300;400;700;900'),
  },
  {
    id: 'nunito',
    label: 'Nunito',
    fontStack: '"Nunito", sans-serif',
    googleFontsUrl: g('Nunito', '400;500;600;700;800'),
  },
  {
    id: 'work-sans',
    label: 'Work Sans',
    fontStack: '"Work Sans", sans-serif',
    googleFontsUrl: g('Work+Sans', '300;400;500;600;700'),
  },
  {
    id: 'dm-sans',
    label: 'DM Sans',
    fontStack: '"DM Sans", sans-serif',
    googleFontsUrl: g('DM+Sans', '400;500;600;700'),
  },
  {
    id: 'manrope',
    label: 'Manrope',
    fontStack: '"Manrope", sans-serif',
    googleFontsUrl: g('Manrope', '400;500;600;700;800'),
  },
];

export const DEFAULT_FONT_ID = 'montserrat';

/**
 * Build a Google Fonts css2 stylesheet URL from a family name typed by the
 * user (exactly as shown on fonts.google.com, e.g. "Roboto Slab").
 */
export function buildGoogleFontUrl(family: string): string {
  const name = family.trim().replace(/\s+/g, '+');
  return `https://fonts.googleapis.com/css2?family=${name}:wght@300;400;500;600;700;800&display=swap`;
}

const FONT_MAP: Record<string, ThemeFont> = Object.fromEntries(
  THEME_FONTS.map((f) => [f.id, f]),
);

/** Resolve a font by id, falling back to Montserrat. */
export function getFont(id: string | undefined | null): ThemeFont {
  return (id && FONT_MAP[id]) || FONT_MAP[DEFAULT_FONT_ID];
}

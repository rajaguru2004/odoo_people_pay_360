# Theming System — Rules & Governance

## Architecture

```
theme/
  index.ts          ← Static fallback theme (build-time default)
  types.ts          ← ThemeConfig TypeScript interface
  provider.tsx      ← React context, CSS var injection, font/favicon injection
  resolveTheme.ts   ← Combines a color preset + a font into one ThemeConfig
  fonts.ts          ← Selectable font registry (10 fonts) + getFont()
  chartColors.ts    ← Recharts hex colors (live singleton, setChartTheme())
  presets/
    index.ts        ← THEME_PRESETS registry + getPreset()
    default.ts      ← Ocean Blue (blue #00358F / orange #f66600)
    emerald.ts      ← Emerald (light)
    violet.ts       ← Violet (light)
    sunset.ts       ← Sunset (rose/amber, light)
    client-a.ts     ← Example white-label (dark sidebar, not in picker)
```

**Runtime theming (dynamic, company-wide):**
The active theme is now selected at runtime from two system-settings keys —
`theme_preset` and `theme_font` — set by Admins in Settings → System Settings →
Theme & Appearance. Flow:
```
system_settings (theme_preset, theme_font)
  → GET /system-settings/public → brandingStore (Zustand)
  → ThemeProvider resolveTheme(presetId, fontId)
  → CSS vars on <html> + Google Font <link> + setChartTheme()
  → Tailwind reads vars → entire app updates live
```
Selecting a preset/font in Settings calls `updateBrandingState()` for instant
live apply; **Save** persists the two keys. To add a preset: create a file in
`presets/`, register it in `presets/index.ts`. To add a font: append to
`THEME_FONTS` in `fonts.ts`.

---

## To Rebrand for a New Client

1. Create `theme/presets/client-xyz.ts` (copy `default.ts`, update values)
2. In `theme/index.ts`:
   ```ts
   import { clientXyzTheme } from './presets/client-xyz';
   export const activeTheme = clientXyzTheme;
   ```
3. Deploy. **Zero other files change.**

---

## Semantic Token Reference

### Brand Colors

| Tailwind Class | CSS Var | Usage |
|---|---|---|
| `bg-brand-primary` | `--color-brand-primary` | CTA buttons, active nav, key indicators |
| `bg-brand-primary-dark` | `--color-brand-primary-dark` | Hover on brand-primary elements |
| `bg-brand-primary-light` | `--color-brand-primary-light` | Subtle bg behind brand elements |
| `text-brand-primary` | same | Brand-colored text |
| `border-brand-primary` | same | Brand-colored borders |
| `bg-brand-accent` | `--color-brand-accent` | Secondary CTAs, highlights |
| `bg-brand-accent-dark` | `--color-brand-accent-dark` | Hover on accent elements |

### Status Colors

| Tailwind Class | Usage |
|---|---|
| `bg-status-success` / `text-status-success` | Success states |
| `bg-status-success-bg` | Light success background |
| `bg-status-warning` / `text-status-warning` | Warning states |
| `bg-status-warning-bg` | Light warning background |
| `bg-status-error` / `text-status-error` | Error / destructive |
| `bg-status-error-bg` | Light error background |
| `bg-status-info` / `text-status-info` | Informational |
| `bg-status-info-bg` | Light info background |

### Surface Colors

| Tailwind Class | Usage |
|---|---|
| `bg-surface-page` | Page / app background |
| `bg-surface-card` | Cards, panels, widgets |
| `bg-surface-overlay` | Dropdowns, modals, tooltips |
| `border-surface-border` | Default borders |
| `border-surface-border-light` | Subtle / inner borders |

### Text Colors

| Tailwind Class | Usage |
|---|---|
| `text-text-heading` | h1–h4 headings |
| `text-text-body` | Paragraph / body text |
| `text-text-muted` | Hints, labels, placeholders |
| `text-text-on-brand` | Text ON brand-primary backgrounds |
| `text-text-on-accent` | Text ON brand-accent backgrounds |

### Sidebar Colors

| Tailwind Class | Usage |
|---|---|
| `bg-sidebar-bg` | Sidebar container background |
| `border-sidebar-border` | Sidebar borders |
| `text-sidebar-text` | Sidebar nav link text |
| `text-sidebar-text-muted` | Sidebar secondary text |
| `bg-sidebar-active-bg` / `text-sidebar-active-text` | Active nav item |
| `bg-sidebar-hover-bg` / `text-sidebar-hover-text` | Hovered nav item |
| `bg-sidebar-sub-active-bg` / `text-sidebar-sub-active-text` | Active sub-item |

### Header Colors

| Tailwind Class | Usage |
|---|---|
| `bg-header-bg` | TopHeader background |
| `border-header-border` | TopHeader bottom border |
| `text-header-text` | TopHeader text |

---

## Chart Colors

Recharts needs hex strings. Always import from `@/theme/chartColors`:

```ts
import { chartColors } from '@/theme/chartColors';

// Single color
<Bar fill={chartColors.primary} />
<Line stroke={chartColors.accent} />

// Multi-series palette
const colors = chartColors.palette;
{data.map((entry, index) => (
  <Cell key={index} fill={colors[index % colors.length]} />
))}

// Semantic names
fill={chartColors.present}   // green
fill={chartColors.absent}    // red
fill={chartColors.late}      // amber
fill={chartColors.leave}     // info/blue
fill={chartColors.overtime}  // accent
```

---

## Opacity Modifiers

Use Tailwind opacity modifiers — never hardcode rgba:

```tsx
// ✅ Correct
<div className="bg-brand-primary/10" />   {/* 10% opacity primary bg */}
<div className="bg-brand-primary/20" />   {/* 20% opacity */}
<div className="ring-brand-primary/30" /> {/* 30% opacity ring */}

// ❌ Wrong
<div style={{ background: 'rgba(0, 53, 143, 0.1)' }} />
```

---

## DO / DON'T Rules

### ✅ DO

```tsx
// Brand colors via semantic tokens
<button className="bg-brand-primary text-text-on-brand hover:bg-brand-primary-dark rounded-[--radius-button]" />

// Status badges
<span className="bg-status-success-bg text-status-success" />

// Cards
<div className="bg-surface-card border border-surface-border" />

// Text hierarchy
<h1 className="text-text-heading" />
<p className="text-text-body" />
<p className="text-text-muted" />

// Opacity modifier
<div className="bg-brand-primary/10" />

// Charts — import chartColors
import { chartColors } from '@/theme/chartColors';
<Bar fill={chartColors.primary} />
```

### ❌ DON'T

```tsx
// Hardcoded brand colors
<button className="bg-blue-500" />           // ← use bg-brand-primary
<button className="bg-[#00358F]" />          // ← use bg-brand-primary
<div style={{ color: '#f66600' }} />         // ← use text-brand-accent

// Tailwind palette for brand
<div className="bg-indigo-600" />            // ← use bg-brand-primary
<div className="text-orange-500" />          // ← use text-brand-accent
<div className="bg-green-100" />             // ← use bg-status-success-bg

// Hardcoded hex in Recharts
<Bar fill="#00358F" />                       // ← use chartColors.primary

// Hardcoded rgba
<div style={{ background: 'rgba(0,53,143,.1)' }} />  // ← use bg-brand-primary/10
```

### Exception: Neutral Grays (Allowed)

`text-slate-500`, `border-slate-200`, `bg-slate-50`, `text-gray-700` etc. are **allowed** for structural neutral elements that carry no brand meaning (e.g. table dividers, skeleton loaders, non-interactive text).

Document each usage with a comment:
```tsx
{/* neutral — not brand-specific */}
<div className="border-slate-100" />
```

---

## Adding a New Token

1. Add field to `ThemeConfig` in `theme/types.ts`
2. Set value in `theme/presets/default.ts` (and all other presets)
3. Add CSS var write in `applyThemeToDom()` in `theme/provider.tsx`
4. Add `@theme inline` mapping in `app/globals.css`
5. Document in this file under the relevant section

---

## Verification Grep Commands

After migrating a file, run to confirm no hardcoded brand colors remain:

```bash
# Check for raw Tailwind color classes that should be semantic
grep -n "bg-blue-[0-9]\|text-blue-[0-9]\|bg-indigo-\|bg-violet-\|text-indigo-" <file>

# Check for hardcoded hex brand colors
grep -n "#00358F\|#f66600\|#AECCFF\|#F4F6FC\|#3b82f6\|#2563eb" <file>

# Full app scan (run before release)
grep -rn "bg-blue-[0-9]\|#00358F\|#f66600" apps/frontend/app apps/frontend/components \
  --include="*.tsx" --include="*.ts" --include="*.css"
```

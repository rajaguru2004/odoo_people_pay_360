import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Guard against class names that LOOK like this product's design tokens and are
 * not.
 *
 * The tokens are declared in `app/globals.css` as `--color-text-on-brand`,
 * `--color-text-muted`, `--color-surface-card` and so on, which Tailwind turns
 * into `text-text-on-brand`, `text-text-muted`, `bg-surface-card`. The shorter
 * spelling reads correctly, matches nothing, and fails SILENTLY: the element
 * simply keeps whatever it inherited.
 *
 * That is not hypothetical. The document module shipped with `text-on-brand` on
 * a solid brand-coloured button, so the label rendered in the inherited dark
 * text on a dark blue background and was invisible — reported by a user who
 * could see the button but not read it. 100 class names across six files were
 * wrong the same way.
 *
 * A type checker cannot catch this (they are strings) and neither can a
 * render test (the element exists either way, just unstyled), so it is checked
 * here against the file text.
 */

const ROOT = join(__dirname, '..', '..');

/** Short spelling → what it should be. */
const FORBIDDEN: Record<string, string> = {
  'text-on-brand': 'text-text-on-brand',
  'text-on-accent': 'text-text-on-accent',
  'text-heading': 'text-text-heading',
  'text-body': 'text-text-body',
  'text-muted': 'text-text-muted',
  'surface-card': 'bg-surface-card',
  'surface-border': 'border-surface-border',
  'surface-page': 'bg-surface-page',
};

/** Directories this guard governs. Add a path when a screen joins the module. */
const GOVERNED = [
  join(ROOT, 'components', 'documents'),
  join(ROOT, 'app', 'dashboard', 'settings', 'documents'),
];

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsxFiles(full));
    else if (entry.endsWith('.tsx') && !entry.endsWith('.test.tsx')) out.push(full);
  }
  return out;
}

describe('document module design tokens', () => {
  const files = GOVERNED.flatMap(tsxFiles);

  it('governs the files it claims to', () => {
    // A guard over an empty set passes for the wrong reason.
    expect(files.length).toBeGreaterThan(4);
    // The visual-editor screens live in a SUBdirectory — pin that the
    // recursive walk reaches them, so moving them out fails here, not silently.
    expect(files.some((f) => f.includes(join('documents', 'visual')))).toBe(true);
  });

  it.each(Object.entries(FORBIDDEN))(
    'never uses the non-existent class "%s" (should be "%s")',
    (bad, good) => {
      // Word-boundary, and never inside the correct longer spelling.
      const pattern = new RegExp(`(?<![\\w-])${bad}(?![\\w-])`, 'g');
      const offenders: string[] = [];
      for (const file of files) {
        const text = readFileSync(file, 'utf8');
        for (const line of text.split('\n')) {
          // Only class strings matter; a CSS var or a comment mentioning the
          // token is fine.
          if (!line.includes('className') && !line.includes("'") && !line.includes('"')) continue;
          if (pattern.test(line)) {
            offenders.push(`${file.replace(ROOT, '')}: ${line.trim().slice(0, 90)}`);
          }
          pattern.lastIndex = 0;
        }
      }
      expect({ bad, good, offenders }).toEqual({ bad, good, offenders: [] });
    },
  );
});

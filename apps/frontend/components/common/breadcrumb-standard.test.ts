import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * The standard, enforced against the source rather than one rendered screen.
 *
 * `DashboardLayout` renders ONE `PageBreadcrumbs` for every dashboard route.
 * The defect this guards against is a page drawing a second trail of its own:
 * five did, and the reader saw two stacked trails answering the same question.
 * A component test can only prove it for the routes it renders — this proves it
 * for all of them, and fails the moment a new page hand-rolls one.
 */

const FRONTEND = join(__dirname, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

const sources = [...walk(join(FRONTEND, 'app')), ...walk(join(FRONTEND, 'components'))];
const rel = (f: string) => f.slice(FRONTEND.length + 1);

describe('one breadcrumb trail, app-wide', () => {
  it('only BreadcrumbTrail declares the Breadcrumb landmark', () => {
    // Two nodes carrying `aria-label="Breadcrumb"` on one page is two trails to
    // a screen reader even when they look like one.
    const owners = sources
      .filter((f) => /aria-label=(["'])Breadcrumb\1/.test(readFileSync(f, 'utf8')))
      .map(rel);

    expect(owners).toEqual(['components/common/BreadcrumbTrail.tsx']);
  });

  it('only PageBreadcrumbs and PageActionRow render BreadcrumbTrail', () => {
    // Those two are the sanctioned callers: the global derived trail, and the
    // in-content row. A third would put a second trail on some route.
    const importers = sources
      .filter((f) => !f.endsWith('BreadcrumbTrail.tsx'))
      .filter((f) => /from '@\/components\/common\/BreadcrumbTrail'/.test(readFileSync(f, 'utf8')))
      .map(rel)
      .sort();

    expect(importers).toEqual([
      'components/common/PageActionRow.tsx',
      'components/common/PageBreadcrumbs.tsx',
    ]);
  });

  it('no dashboard page builds a chevron trail out of its own parent links', () => {
    // The shape the five removed trails all had: a directional chevron sitting
    // in the same file as a router.push to a parent list, outside the shared
    // components. Matching on the icon import keeps this cheap and specific —
    // a chevron used for a dropdown or an accordion does not trip it, because
    // those are lucide's, not the RTL-mirroring directional set the trails used.
    const offenders = sources
      .filter((f) => rel(f).startsWith('app/dashboard/'))
      .filter((f) => {
        const src = readFileSync(f, 'utf8');
        if (!/ChevronRightIcon/.test(src)) return false;
        // A trail is a chevron next to a link OUT of this page, in a text row.
        return /\{\/\*\s*Breadcrumb/i.test(src);
      })
      .map(rel);

    expect(offenders).toEqual([]);
  });
});

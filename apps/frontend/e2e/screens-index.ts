import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, resolve } from 'path';

/**
 * The contact sheet — every captured phone screen on one page.
 *
 * The reviewer for this work does not run the stack. They need to look at forty
 * screens, compare them, and see the numbers behind each one, on whatever
 * device is to hand. So the output is a single static `index.html` beside the
 * PNGs: no server, no npm, no Playwright — double-click it, or publish it.
 *
 * ## Why it rebuilds itself from sidecars
 *
 * The phone suite runs one spec FILE at a time (`playwright_test.sh`), and a
 * screen can be re-verified on its own days after its batch. There is no single
 * moment at which "all the results" exist in one process. So each audit drops a
 * small JSON sidecar next to its capture, and the index is regenerated from
 * whatever sidecars are on disk. Re-running one screen updates one card and
 * leaves the other thirty-nine alone.
 *
 * Nothing here is committed — `apps/frontend/.gitignore` covers `e2e/.screens/`,
 * and forty screens of PNGs is ~30MB of churn per pass.
 */

const OUT_DIR = resolve(__dirname, '.screens');

export interface ScreenRecord {
  /** Capture stem, e.g. `ess-my-leaves`. */
  name: string;
  /** Human label from the audit. */
  label: string;
  /** Route the capture was taken on. */
  path: string;
  /** PNG file names, in order. */
  shots: string[];
  /** Overflow px per width — 0 everywhere is the pass. */
  overflow: Record<number, number>;
  /** Controls found under 44×44 (after `allow`). */
  undersized: number;
  /** Form controls under 16px. */
  smallFonts: number;
  /** Gap in px between the last content and the tab bar. */
  tabBarGap: number | null;
  /** Documented exceptions, each with its reason. */
  allow: Array<{ selector: string; why: string }>;
}

export function writeScreenRecord(record: ScreenRecord): void {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, `${record.name}.json`), JSON.stringify(record, null, 2));
}

function loadRecords(): ScreenRecord[] {
  if (!existsSync(OUT_DIR)) return [];
  return readdirSync(OUT_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(resolve(OUT_DIR, f), 'utf8')) as ScreenRecord)
    .sort((a, b) => a.name.localeCompare(b.name));
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function card(record: ScreenRecord): string {
  const widths = Object.keys(record.overflow).map(Number).sort((a, b) => b - a);
  const overflowOk = widths.every((w) => record.overflow[w] === 0);
  const ok = overflowOk && record.undersized === 0 && record.smallFonts === 0;

  const shots = record.shots
    .map((s) => `<img src="./${escapeHtml(basename(s))}" alt="${escapeHtml(record.label)}" loading="lazy">`)
    .join('');

  const stats = [
    `<span class="${overflowOk ? 'ok' : 'bad'}">overflow ${widths.map((w) => `${w}px:${record.overflow[w]}`).join(' · ')}</span>`,
    `<span class="${record.undersized === 0 ? 'ok' : 'bad'}">targets &lt;44: ${record.undersized}</span>`,
    `<span class="${record.smallFonts === 0 ? 'ok' : 'bad'}">fonts &lt;16: ${record.smallFonts}</span>`,
    record.tabBarGap == null ? '' : `<span class="ok">tab-bar gap ${record.tabBarGap}px</span>`,
  ]
    .filter(Boolean)
    .join('');

  const exceptions = record.allow.length
    ? `<ul class="allow">${record.allow
        .map((a) => `<li><code>${escapeHtml(a.selector)}</code> — ${escapeHtml(a.why)}</li>`)
        .join('')}</ul>`
    : '';

  return `<article class="screen">
  <header>
    <h2>${escapeHtml(record.label)} ${ok ? '<span class="pill ok">clean</span>' : '<span class="pill bad">findings</span>'}</h2>
    <code>${escapeHtml(record.path)}</code>
  </header>
  <div class="stats">${stats}</div>
  ${exceptions}
  <div class="frames">${shots}</div>
</article>`;
}

/** Regenerates `index.html` from every sidecar on disk. */
export function rebuildContactSheet(): string {
  const records = loadRecords();
  mkdirSync(OUT_DIR, { recursive: true });

  const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ESS portal — phone review</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f7fb; --card:#fff; --ink:#0f172a; --muted:#64748b;
          --line:#e2e8f0; --ok:#0f766e; --okbg:#ccfbf1; --bad:#b91c1c; --badbg:#fee2e2; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0b1120; --card:#111827; --ink:#e5e7eb; --muted:#94a3b8; --line:#1f2937;
            --ok:#5eead4; --okbg:#134e4a; --bad:#fca5a5; --badbg:#7f1d1d; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px; background:var(--bg); color:var(--ink);
         font:14px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif; }
  h1 { font-size:20px; margin:0 0 4px; }
  .lede { color:var(--muted); margin:0 0 24px; max-width:60ch; }
  .grid { display:grid; gap:20px; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); }
  .screen { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:16px; }
  .screen h2 { font-size:15px; margin:0 0 2px; display:flex; align-items:center; gap:8px; }
  .screen code { color:var(--muted); font-size:12px; }
  .stats { display:flex; flex-wrap:wrap; gap:6px; margin:10px 0; }
  .stats span, .pill { font-size:11px; font-weight:600; padding:2px 8px; border-radius:999px; }
  .ok { background:var(--okbg); color:var(--ok); }
  .bad { background:var(--badbg); color:var(--bad); }
  .allow { margin:8px 0; padding-left:18px; color:var(--muted); font-size:12px; }
  .frames { display:flex; gap:12px; overflow-x:auto; padding-bottom:4px; }
  .frames img { width:260px; flex:0 0 auto; border:1px solid var(--line); border-radius:12px; background:#fff; }
  footer { margin-top:28px; color:var(--muted); font-size:12px; }
</style>
<h1>ESS portal — phone review</h1>
<p class="lede">Every ESS screen captured at 390&nbsp;CSS&nbsp;px. Each card carries the audit
numbers behind it: horizontal overflow at each tested width, controls under 44×44, form
controls under a 16px font, and the gap between the last content and the fixed tab bar.
A screen with a <em>findings</em> pill has not been delivered yet.</p>
<div class="grid">
${records.map(card).join('\n')}
</div>
<footer>${records.length} screen${records.length === 1 ? '' : 's'} captured ·
regenerated on every <code>E2E_SCREENS=1</code> run · see docs/ESS-MOBILE-UI-TRACKER.md</footer>
`;

  const path = resolve(OUT_DIR, 'index.html');
  writeFileSync(path, html);
  return path;
}

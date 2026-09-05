import type { Page } from '@playwright/test';

/**
 * Screenshot annotation for the ESS user manual.
 *
 * The manual's screenshots have to survive being read by someone who is stuck,
 * on paper, in greyscale, months from now. That rules out the obvious approach
 * of pointing at things in prose ("the button on the right"): the reader has to
 * be able to look at the picture and the legend and nothing else.
 *
 * So every captured screen carries NUMBERED CALLOUTS drawn onto the live page
 * just before the shutter — a ring around the control, a numbered badge beside
 * it, and where the target is small or ambiguous, an arrow from a floating
 * label. The document then repeats those numbers in a legend table, which is
 * the convention every serious software manual uses and the only one that
 * degrades gracefully to print.
 *
 * ## Why the overlay is drawn in the page rather than composited afterwards
 *
 * Compositing arrows onto a PNG afterwards means hard-coding pixel coordinates,
 * and those coordinates are wrong the moment a label's text changes or a card
 * gains a row. Anchoring to the DOM means the annotation moves with the thing
 * it points at, so a re-capture after a UI change is still correct. A callout
 * whose selector no longer resolves is REPORTED (see `AnnotateResult.missing`)
 * rather than silently dropped, which is what turns a stale manual into a
 * visible failure instead of a picture with a number missing from its legend.
 */

/** Where a badge sits relative to its target's box. */
export type BadgeAnchor =
  | 'tl' | 'tr' | 'bl' | 'br'
  | 'left' | 'right' | 'top' | 'bottom'
  | 'center';

export interface Callout {
  /**
   * What to point at. Three forms, resolved in the browser:
   *   `testid=leave-submit`  → [data-testid="leave-submit"]
   *   `text=Apply for Leave` → the SMALLEST element whose trimmed text matches
   *   anything else          → used as a plain CSS selector
   *
   * `text=` matches case-insensitively and prefers an exact match over a
   * containing one, then the smallest box among equals — otherwise a phrase
   * inside a card resolves to the whole card, and the ring swallows the screen.
   */
  selector: string;
  /** The legend entry. The number is assigned from array order. */
  label: string;
  /** Badge placement. Default `tl`. */
  badge?: BadgeAnchor;
  /** Draw the ring around the target. Default true. */
  ring?: boolean;
  /**
   * Draw an arrow to the target from a label floating in free space.
   * Use for controls too small to ring legibly, or where the ring would sit on
   * top of the text the reader needs to read.
   */
  arrow?: {
    /** Which side of the target the arrow comes FROM. */
    from: 'left' | 'right' | 'top' | 'bottom';
    /** Text in the floating label. Defaults to the callout's `label`. */
    text?: string;
    /** How far out the label sits, in px. Default 120. */
    distance?: number;
  };
  /** Grow the ring by this many px on every side. Default 6. */
  pad?: number;
  /**
   * Tolerate this callout not resolving.
   *
   * For controls that only exist in a particular state — a Cancel button that
   * appears on PENDING rows only. The number is skipped and the caller is told,
   * so the legend can be written to match rather than referring to a badge that
   * was never drawn.
   */
  optional?: boolean;
}

export interface AnnotateResult {
  /** Labels of callouts whose selector matched nothing. */
  missing: string[];
  /** Labels that were drawn, in the order their numbers were assigned. */
  drawn: string[];
}

/** The id of the injected layer, so it can be torn down again. */
const LAYER_ID = '__ess_manual_overlay__';

/**
 * Draw `callouts` onto the page and leave them there for the screenshot.
 *
 * Numbering is by array order and counts only the callouts that resolved, so
 * an optional one that was absent does not leave a hole in the sequence. The
 * returned `drawn` array is therefore the exact legend, in order — build the
 * document's legend table from it rather than from the input.
 */
export async function annotate(page: Page, callouts: Callout[]): Promise<AnnotateResult> {
  return page.evaluate(
    ({ layerId, items }) => {
      document.getElementById(layerId)?.remove();

      const SVG_NS = 'http://www.w3.org/2000/svg';
      /** Vivid enough to survive greyscale printing, and not a brand colour. */
      const ACCENT = '#E8590C';
      const HALO = '#FFFFFF';

      /**
       * Resolve one selector to the most specific element that matches.
       *
       * Never throws. A malformed selector — a Playwright-only form such as
       * `:has-text()` reaching this CSS-only resolver — used to take down the
       * whole `annotate` call, and with it every remaining figure in the spec:
       * one typo cost three tests and twelve pictures. A selector that cannot
       * be parsed is simply a callout that did not resolve, which the manifest
       * already knows how to report.
       */
      const resolve = (selector: string): Element | null => {
        try {
          return resolveOrThrow(selector);
        } catch {
          return null;
        }
      };

      const resolveOrThrow = (selector: string): Element | null => {
        if (selector.startsWith('testid=')) {
          return document.querySelector(
            `[data-testid="${selector.slice('testid='.length)}"]`,
          );
        }

        if (selector.startsWith('text=')) {
          const needle = selector.slice('text='.length).trim().toLowerCase();
          const candidates: Array<{ el: Element; exact: boolean; area: number }> = [];

          document.querySelectorAll('body *').forEach((el) => {
            // Containers full of other things are never the answer.
            const own = (el.textContent ?? '').trim().toLowerCase();
            if (!own.includes(needle)) return;
            const rect = el.getBoundingClientRect();
            if (rect.width < 4 || rect.height < 4) return;
            candidates.push({ el, exact: own === needle, area: rect.width * rect.height });
          });

          if (!candidates.length) return null;
          // Exact text beats containing text; among equals, the smallest box.
          candidates.sort((a, b) =>
            a.exact === b.exact ? a.area - b.area : a.exact ? -1 : 1,
          );
          return candidates[0].el;
        }

        return document.querySelector(selector);
      };

      /** A box is only worth annotating if it is actually on screen. */
      const visible = (r: DOMRect) =>
        r.width > 0 &&
        r.height > 0 &&
        r.bottom > 0 &&
        r.right > 0 &&
        r.top < window.innerHeight &&
        r.left < window.innerWidth;

      const layer = document.createElement('div');
      layer.id = layerId;
      Object.assign(layer.style, {
        position: 'fixed',
        inset: '0',
        // Above every modal, toast and sticky header this app has.
        zIndex: '2147483647',
        pointerEvents: 'none',
      } as CSSStyleDeclaration);

      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('width', String(window.innerWidth));
      svg.setAttribute('height', String(window.innerHeight));
      Object.assign(svg.style, {
        position: 'absolute',
        inset: '0',
        overflow: 'visible',
      } as CSSStyleDeclaration);

      // One arrowhead definition, referenced by every arrow.
      const defs = document.createElementNS(SVG_NS, 'defs');
      const marker = document.createElementNS(SVG_NS, 'marker');
      marker.setAttribute('id', 'ess-arrowhead');
      marker.setAttribute('viewBox', '0 0 10 10');
      marker.setAttribute('refX', '9');
      marker.setAttribute('refY', '5');
      marker.setAttribute('markerWidth', '7');
      marker.setAttribute('markerHeight', '7');
      marker.setAttribute('orient', 'auto-start-reverse');
      const head = document.createElementNS(SVG_NS, 'path');
      head.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
      head.setAttribute('fill', ACCENT);
      marker.appendChild(head);
      defs.appendChild(marker);
      svg.appendChild(defs);
      layer.appendChild(svg);

      const missing: string[] = [];
      const drawn: string[] = [];

      for (const item of items) {
        const el = resolve(item.selector);
        const rect = el?.getBoundingClientRect();

        if (!el || !rect || !visible(rect)) {
          missing.push(item.label);
          continue;
        }

        const n = drawn.length + 1;
        drawn.push(item.label);

        const pad = item.pad ?? 6;
        const x = rect.left - pad;
        const y = rect.top - pad;
        const w = rect.width + pad * 2;
        const h = rect.height + pad * 2;

        if (item.ring !== false) {
          // A white halo UNDER the accent stroke, so the ring reads on both the
          // light and the dark theme without knowing which one is on.
          for (const [stroke, width] of [[HALO, 6], [ACCENT, 3]] as const) {
            const r = document.createElementNS(SVG_NS, 'rect');
            r.setAttribute('x', String(x));
            r.setAttribute('y', String(y));
            r.setAttribute('width', String(w));
            r.setAttribute('height', String(h));
            r.setAttribute('rx', '8');
            r.setAttribute('fill', 'none');
            r.setAttribute('stroke', stroke);
            r.setAttribute('stroke-width', String(width));
            svg.appendChild(r);
          }
        }

        // ── the numbered badge ────────────────────────────────────────────
        const anchor = item.badge ?? 'tl';
        const point = (() => {
          switch (anchor) {
            case 'tr': return { cx: x + w, cy: y };
            case 'bl': return { cx: x, cy: y + h };
            case 'br': return { cx: x + w, cy: y + h };
            case 'left': return { cx: x - 4, cy: y + h / 2 };
            case 'right': return { cx: x + w + 4, cy: y + h / 2 };
            case 'top': return { cx: x + w / 2, cy: y - 4 };
            case 'bottom': return { cx: x + w / 2, cy: y + h + 4 };
            case 'center': return { cx: x + w / 2, cy: y + h / 2 };
            default: return { cx: x, cy: y };
          }
        })();

        // Keep the badge inside the frame — a callout half off the edge is
        // unreadable, and the top-left of a full-width card is exactly where
        // that happens.
        const R = 15;
        const cx = Math.min(Math.max(point.cx, R + 2), window.innerWidth - R - 2);
        const cy = Math.min(Math.max(point.cy, R + 2), window.innerHeight - R - 2);

        const halo = document.createElementNS(SVG_NS, 'circle');
        halo.setAttribute('cx', String(cx));
        halo.setAttribute('cy', String(cy));
        halo.setAttribute('r', String(R + 2));
        halo.setAttribute('fill', HALO);
        svg.appendChild(halo);

        const disc = document.createElementNS(SVG_NS, 'circle');
        disc.setAttribute('cx', String(cx));
        disc.setAttribute('cy', String(cy));
        disc.setAttribute('r', String(R));
        disc.setAttribute('fill', ACCENT);
        svg.appendChild(disc);

        const text = document.createElementNS(SVG_NS, 'text');
        text.setAttribute('x', String(cx));
        text.setAttribute('y', String(cy));
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('dominant-baseline', 'central');
        text.setAttribute('fill', '#FFFFFF');
        text.setAttribute('font-family', 'Arial, Helvetica, sans-serif');
        text.setAttribute('font-size', '17');
        text.setAttribute('font-weight', '700');
        text.textContent = String(n);
        svg.appendChild(text);

        // ── the optional arrow and its floating label ──────────────────────
        if (item.arrow) {
          const dist = item.arrow.distance ?? 120;
          const tip = (() => {
            switch (item.arrow.from) {
              case 'left': return { tx: x, ty: y + h / 2, lx: x - dist, ly: y + h / 2 };
              case 'right': return { tx: x + w, ty: y + h / 2, lx: x + w + dist, ly: y + h / 2 };
              case 'top': return { tx: x + w / 2, ty: y, lx: x + w / 2, ly: y - dist };
              default: return { tx: x + w / 2, ty: y + h, lx: x + w / 2, ly: y + h + dist };
            }
          })();

          for (const [stroke, width] of [[HALO, 6], [ACCENT, 2.5]] as const) {
            const line = document.createElementNS(SVG_NS, 'path');
            // A gentle bow, so the arrow reads as an annotation rather than as
            // part of the interface.
            const mx = (tip.lx + tip.tx) / 2;
            const my = (tip.ly + tip.ty) / 2;
            const bow = item.arrow.from === 'left' || item.arrow.from === 'right' ? -22 : 22;
            line.setAttribute(
              'd',
              `M ${tip.lx} ${tip.ly} Q ${mx + bow} ${my - bow} ${tip.tx} ${tip.ty}`,
            );
            line.setAttribute('fill', 'none');
            line.setAttribute('stroke', stroke);
            line.setAttribute('stroke-width', String(width));
            line.setAttribute('stroke-linecap', 'round');
            if (stroke === ACCENT) line.setAttribute('marker-end', 'url(#ess-arrowhead)');
            svg.appendChild(line);
          }

          const caption = item.arrow.text ?? item.label;
          const chip = document.createElement('div');
          chip.textContent = caption;
          Object.assign(chip.style, {
            position: 'absolute',
            left: `${tip.lx}px`,
            top: `${tip.ly}px`,
            transform: 'translate(-50%, -50%)',
            maxWidth: '230px',
            background: ACCENT,
            color: '#FFFFFF',
            font: '600 13px/1.35 Arial, Helvetica, sans-serif',
            padding: '6px 10px',
            borderRadius: '6px',
            boxShadow: `0 0 0 3px ${HALO}`,
            textAlign: 'center',
          } as CSSStyleDeclaration);
          layer.appendChild(chip);
        }
      }

      document.body.appendChild(layer);
      return { missing, drawn };
    },
    { layerId: LAYER_ID, items: callouts },
  );
}

/** Remove the overlay, for a second capture of the same screen. */
export async function clearAnnotations(page: Page): Promise<void> {
  await page.evaluate((id) => document.getElementById(id)?.remove(), LAYER_ID);
}

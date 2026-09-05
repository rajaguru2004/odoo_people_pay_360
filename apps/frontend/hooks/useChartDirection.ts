'use client';

import { useEffect, useState } from 'react';

/**
 * The axis props a chart needs to read correctly under `dir="rtl"`.
 *
 * Logical CSS (`ps-*`, `me-*`, `start-*`) flips the panel around a chart and
 * does nothing whatsoever to the chart itself: an SVG has no writing direction,
 * so Recharts keeps drawing its categories left-to-right and its value axis on
 * the left however the document is set. An Arabic reader then gets a chart that
 * starts where their eye finishes.
 *
 * Read from the DOM rather than from the locale, because `dir` is what actually
 * governs the layout and a nested `dir` on a subtree would otherwise be missed.
 * Resolved after mount: the server has no document to ask, and guessing would
 * flash the wrong axis on first paint.
 */
export interface ChartDirection {
  rtl: boolean;
  /** Spread onto `<XAxis>` — reverses the category order. */
  xAxisProps: { reversed: boolean };
  /** Spread onto `<YAxis>` — moves the value axis to the reading edge. */
  yAxisProps: { orientation: 'left' | 'right' };
}

export function useChartDirection(): ChartDirection {
  const [rtl, setRtl] = useState(false);

  useEffect(() => {
    const read = () =>
      setRtl(document.documentElement.getAttribute('dir') === 'rtl');
    read();

    // The locale switcher flips `dir` on the live document rather than
    // reloading, so a chart mounted before the switch has to hear about it.
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['dir'],
    });
    return () => observer.disconnect();
  }, []);

  return {
    rtl,
    xAxisProps: { reversed: rtl },
    yAxisProps: { orientation: rtl ? 'right' : 'left' },
  };
}

/**
 * An SVG path through `values`, drawn to fill a `width` × `height` box.
 *
 * The series is normalised to its own min and max, so the line describes the
 * SHAPE of the movement rather than its magnitude — which is the only thing a
 * 64px sparkline beside a KPI can honestly show.
 *
 * Fewer than two points draws nothing at all. One reading is not a trend, and a
 * flat line through it reads as "steady", which is a claim about a shape that is
 * not in the data.
 */
export function generateSparkPath(values: number[], width: number, height: number): string {
  if (!values || values.length < 2) return '';

  const max = Math.max(...values);
  const min = Math.min(...values);
  // A series that never moves would divide by zero; 1 flattens it onto the
  // baseline instead.
  const range = max - min === 0 ? 1 : max - min;
  // Half a stroke of breathing room top and bottom, so the peak and the trough
  // are not clipped by the viewBox edge.
  const padding = 4;
  const usable = Math.max(height - padding * 2, 1);

  return values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      // Inverted: SVG y grows downward, and a rising number should rise.
      const y = height - ((value - min) / range) * usable - padding;
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
}

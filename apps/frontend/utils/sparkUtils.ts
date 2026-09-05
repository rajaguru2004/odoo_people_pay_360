// Converts array of numbers to SVG path string for sparkline rendering
export function generateSparkPath(data: number[], width = 120, height = 32): string {
  if (!data || data.length < 2) {
    return `M 0 ${height / 2} L ${width} ${height / 2}`;
  }

  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min === 0 ? 1 : max - min;

  return data
    .map((val, index) => {
      const x = (index / (data.length - 1)) * width;
      // Invert Y coordinate because SVG coordinates start from top-left (0,0)
      const y = height - ((val - min) / range) * (height - 8) - 4;
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
}

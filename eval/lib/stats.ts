/** Small seeded PRNG so bootstrap intervals are reproducible run to run. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Interval {
  estimate: number;
  low: number;
  high: number;
}

/**
 * Percentile bootstrap over cases. Cases are the unit of resampling because
 * calls within one span share a session, so treating calls as independent
 * would make the intervals far too tight.
 */
export function bootstrap<T>(
  items: readonly T[],
  statistic: (sample: readonly T[]) => number,
  iterations = 2000,
  seed = 1,
): Interval {
  const estimate = statistic(items);
  if (items.length < 2) return { estimate, low: NaN, high: NaN };
  const random = mulberry32(seed);
  const draws: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const sample = Array.from({ length: items.length }, () => items[Math.floor(random() * items.length)]!);
    const value = statistic(sample);
    if (Number.isFinite(value)) draws.push(value);
  }
  draws.sort((a, b) => a - b);
  return {
    estimate,
    low: draws[Math.floor(0.025 * draws.length)] ?? NaN,
    high: draws[Math.min(draws.length - 1, Math.floor(0.975 * draws.length))] ?? NaN,
  };
}

export const formatInterval = (interval: Interval, scale = 100, digits = 1, unit = ' pt'): string => {
  const f = (value: number): string => (Number.isFinite(value) ? (value * scale).toFixed(digits) : '—');
  return `${interval.estimate >= 0 ? '+' : ''}${f(interval.estimate)}${unit} [${f(interval.low)}, ${f(interval.high)}]`;
};

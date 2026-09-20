import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const OUT_DIR = join(import.meta.dirname, '..', 'out');

export function writeOut(name: string, data: unknown): string {
  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, name);
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  return path;
}

export const pct = (value: number, digits = 0): string =>
  Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : '—';
export const num = (value: number, digits = 0): string =>
  Number.isFinite(value) ? value.toFixed(digits) : '—';

/** Left-aligns the first column, right-aligns the rest. */
export function table(rows: readonly (readonly string[])[]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map(row => row[column]!.length)));
  return rows
    .map(row => row.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!))).join('  '))
    .join('\n');
}

export function quantiles(values: readonly number[], points: readonly number[] = [0.5, 0.9, 1]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  return points.map(point => sorted[Math.min(sorted.length - 1, Math.floor(point * sorted.length))] ?? NaN);
}

export function argument(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export const flag = (name: string): boolean => process.argv.includes(name);

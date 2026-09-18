import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runJevCommand } from '../src/commands/extension.js';
import type { CliIo } from '../src/cli/main.js';

const dirs: string[] = [];
function makeIo(env: Record<string, string | undefined> = {}): CliIo {
  const dir = mkdtempSync(join(tmpdir(), 'pi-jev-cmd-'));
  dirs.push(dir);
  return {
    env,
    globalPath: join(dir, 'global.json'),
    projectPath: join(dir, 'project', 'jev.json'),
    out: () => {},
    err: () => {},
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('runJevCommand', () => {
  it('empty args show the resolved config', () => {
    const lines: string[] = [];
    const io = { ...makeIo(), out: (t: string) => lines.push(t) } satisfies CliIo;
    expect(runJevCommand('', io)).toBe(0);
    expect(lines.some((line) => line.startsWith('model') && line.includes('# default'))).toBe(true);
    expect(lines.some((line) => line.startsWith('apiKey'))).toBe(true);
  });

  it('set/get drive the same engine as the CLI', () => {
    const io = makeIo();
    expect(runJevCommand('set routing.cheap deepseek/deepseek-flash', io)).toBe(0);
    expect(JSON.parse(readFileSync(io.globalPath, 'utf8'))).toEqual({ routing: { cheap: 'deepseek/deepseek-flash' } });
    const lines: string[] = [];
    expect(runJevCommand('get routing.cheap', { ...io, out: (t) => lines.push(t) })).toBe(0);
    expect(lines.at(-1)).toBe('deepseek/deepseek-flash');
  });

  it('tolerates a redundant config prefix', () => {
    const io = makeIo();
    expect(runJevCommand('config set model m', io)).toBe(0);
    expect(JSON.parse(readFileSync(io.globalPath, 'utf8'))).toEqual({ model: 'm' });
  });

  it('unknown input exits 1', () => {
    const io = makeIo();
    expect(runJevCommand('frobnicate x', io)).toBe(1);
  });
});

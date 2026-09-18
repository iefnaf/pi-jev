import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configFromEnv } from '../src/shared/config.js';
import { runCli, type CliIo } from '../src/cli/main.js';

interface Harness {
  io: CliIo;
  lines: string[];
  errs: string[];
}

const dirs: string[] = [];
function makeIo(env: Record<string, string | undefined> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'pi-jev-cli-'));
  dirs.push(dir);
  const lines: string[] = [];
  const errs: string[] = [];
  return {
    io: {
      env,
      globalPath: join(dir, 'global.json'),
      projectPath: join(dir, 'project', 'jev.json'),
      out: (text) => {
        lines.push(text);
      },
      err: (text) => {
        errs.push(text);
      },
    },
    lines,
    errs,
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('configFromEnv file layer', () => {
  it('file values fill in where env is absent', () => {
    const config = configFromEnv({ OPENROUTER_API_KEY: 'or' }, { model: 'typesafe/jev-9', routing: { cheap: 'deepseek/x' } });
    expect(config.model).toBe('typesafe/jev-9');
    expect(config.routing.cheap).toBe('deepseek/x');
  });

  it('env overrides file', () => {
    const config = configFromEnv({ OPENROUTER_API_KEY: 'or', JEVC_MODEL: 'm-env' }, { model: 'm-file' });
    expect(config.model).toBe('m-env');
  });

  it('file provider beats key sniffing', () => {
    const config = configFromEnv({ TYPESAFE_API_KEY: 'ts', OPENROUTER_API_KEY: 'or' }, { provider: 'openrouter' });
    expect(config.provider).toBe('openrouter');
    expect(config.baseUrl).toContain('openrouter.ai');
  });

  it('file disabled flag works and env still wins', () => {
    expect(configFromEnv({}, { disabled: true }).disabled).toBe(true);
    expect(configFromEnv({ JEVC_DISABLED: '0' }, { disabled: true }).disabled).toBe(false);
  });
});

describe('runCli', () => {
  it('set/get roundtrip writes readable JSON', () => {
    const { io, lines } = makeIo();
    expect(runCli(['config', 'set', 'routing.cheap', 'deepseek/deepseek-flash'], io)).toBe(0);
    expect(JSON.parse(readFileSync(io.globalPath, 'utf8'))).toEqual({ routing: { cheap: 'deepseek/deepseek-flash' } });
    expect(runCli(['config', 'set', 'compaction.keepThreshold', '0.45'], io)).toBe(0);
    expect(JSON.parse(readFileSync(io.globalPath, 'utf8'))).toEqual({
      routing: { cheap: 'deepseek/deepseek-flash' },
      compaction: { keepThreshold: 0.45 },
    });
    expect(runCli(['config', 'get', 'compaction.keepThreshold'], io)).toBe(0);
    expect(lines.at(-1)).toBe('0.45');
  });

  it('set --project writes the project file', () => {
    const { io } = makeIo();
    expect(runCli(['config', 'set', 'model', 'typesafe/jev-1.13', '-l'], io)).toBe(0);
    expect(JSON.parse(readFileSync(io.projectPath, 'utf8'))).toEqual({ model: 'typesafe/jev-1.13' });
  });

  it('unknown keys and API keys are rejected', () => {
    const { io, errs } = makeIo();
    expect(runCli(['config', 'set', 'apiKey', 'sk-123'], io)).toBe(1);
    expect(errs[0]).toContain('unknown key');
    expect(runCli(['config', 'set', 'nope.x', '1'], io)).toBe(1);
  });

  it('rejects values of the wrong type', () => {
    const { io, errs } = makeIo();
    expect(runCli(['config', 'set', 'compaction.keepThreshold', 'abc'], io)).toBe(1);
    expect(errs.some((line) => line.includes('expected a number'))).toBe(true);
    expect(runCli(['config', 'set', 'disabled', 'maybe'], io)).toBe(1);
    expect(runCli(['config', 'set', 'provider', 'weird'], io)).toBe(1);
  });

  it('unset removes the key and prunes empty sections', () => {
    const { io, lines } = makeIo();
    runCli(['config', 'set', 'routing.cheap', 'a/b'], io);
    runCli(['config', 'set', 'model', 'm'], io);
    expect(runCli(['config', 'unset', 'routing.cheap'], io)).toBe(0);
    expect(JSON.parse(readFileSync(io.globalPath, 'utf8'))).toEqual({ model: 'm' });
    expect(runCli(['config', 'unset', 'routing.strong'], io)).toBe(0);
    expect(lines.at(-1)).toContain('not set');
  });

  it('show reports the winning source per key', () => {
    const { io, lines } = makeIo();
    runCli(['config', 'set', 'model', 'm-file'], io);
    runCli(['config', 'set', 'provider', 'openrouter', '-l'], io);
    io.env.JEVC_MODEL = 'm-env';
    expect(runCli(['config'], io)).toBe(0);
    const modelLine = lines.find((line) => line.startsWith('model'));
    expect(modelLine).toContain('m-env');
    expect(modelLine).toContain('# env');
    const providerLine = lines.find((line) => line.startsWith('provider'));
    expect(providerLine).toContain('# project');
    const keepLine = lines.find((line) => line.startsWith('compaction.keepThreshold'));
    expect(keepLine).toContain('# default');
  });

  it('project file beats global file', () => {
    const { io, lines } = makeIo();
    runCli(['config', 'set', 'model', 'm-global'], io);
    runCli(['config', 'set', 'model', 'm-project', '-l'], io);
    expect(runCli(['config', 'get', 'model'], io)).toBe(0);
    expect(lines.at(-1)).toBe('m-project');
  });

  it('path prints the target file', () => {
    const { io, lines } = makeIo();
    expect(runCli(['config', 'path'], io)).toBe(0);
    expect(lines.at(-1)).toBe(io.globalPath);
    expect(runCli(['config', 'path', '-l'], io)).toBe(0);
    expect(lines.at(-1)).toBe(io.projectPath);
  });

  it('malformed JSON in a file is reported, not fatal', () => {
    const { io, errs } = makeIo();
    writeFileSync(io.globalPath, '{ nope');
    expect(runCli(['config', 'get', 'model'], io)).toBe(0);
    expect(errs.some((line) => line.includes('ignoring global config'))).toBe(true);
  });

  it('help exits 0, unknown command exits 1', () => {
    const { io } = makeIo();
    expect(runCli([], io)).toBe(0);
    expect(runCli(['frobnicate'], io)).toBe(1);
  });
});

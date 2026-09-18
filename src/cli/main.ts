import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  CONFIG_KEYS,
  configFromEnv,
  loadConfig,
  mergeConfigFiles,
  readConfigFile,
  type ConfigKeyMeta,
  type JevFileConfig,
} from '../shared/config.js';

/** Injectable process surface, so tests can run the CLI against temp dirs. */
export interface CliIo {
  env: Record<string, string | undefined>;
  globalPath: string;
  projectPath: string;
  out(text: string): void;
  err(text: string): void;
}

const USAGE = `pi-jev — configuration CLI for the pi-jev extension suite

Usage:
  pi-jev config                          Show resolved config and each value's source
  pi-jev config set <key> <value>        Write a key (global by default)
  pi-jev config get <key>                Print the resolved value of a key
  pi-jev config unset <key>              Remove a key
  pi-jev config path                     Print the config file path
  pi-jev config keys                     List all keys with types and env overrides

Options:
  -l, --project    Target the project file (.pi/jev.json) instead of the global one

Sources resolve highest-first: environment variables > project file > global file > defaults.
API keys are environment-only and never stored in files.
Changes take effect after pi restarts or /reload.`;

export function keyMeta(path: string): ConfigKeyMeta | undefined {
  return CONFIG_KEYS.find((key) => key.path === path);
}

export function getPath(file: JevFileConfig, path: string): unknown {
  const [section, key] = path.split('.');
  if (!key) return (file as Record<string, unknown>)[section];
  return (file as Record<string, Record<string, unknown>>)[section]?.[key];
}

export function setPath(file: JevFileConfig, path: string, value: unknown): void {
  const [section, key] = path.split('.');
  if (!key) {
    (file as Record<string, unknown>)[section] = value;
    return;
  }
  const holder = ((file as Record<string, Record<string, unknown>>)[section] ??= {});
  holder[key] = value;
}

function deletePath(file: JevFileConfig, path: string): boolean {
  const [section, key] = path.split('.');
  if (!key) return delete (file as Record<string, unknown>)[section];
  const holder = (file as Record<string, Record<string, unknown>>)[section];
  if (!holder || !(key in holder)) return false;
  delete holder[key];
  if (Object.keys(holder).length === 0) delete (file as Record<string, unknown>)[section];
  return true;
}

export function coerce(meta: ConfigKeyMeta, raw: string): string | number | boolean {
  if (meta.type === 'number') {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${meta.path}: expected a number, got "${raw}"`);
    return value;
  }
  if (meta.type === 'boolean') {
    if (/^(1|true|yes)$/i.test(raw)) return true;
    if (/^(0|false|no)$/i.test(raw)) return false;
    throw new Error(`${meta.path}: expected a boolean, got "${raw}"`);
  }
  const value = raw.trim();
  if (!value) throw new Error(`${meta.path}: expected a non-empty value`);
  if (meta.path === 'provider' && value !== 'typesafe' && value !== 'openrouter') {
    throw new Error(`provider: expected "typesafe" or "openrouter", got "${value}"`);
  }
  return value;
}

export function readOrInit(path: string): JevFileConfig {
  try {
    return readConfigFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`cannot read ${path}: ${(error as Error).message}`);
  }
}

export function saveFile(path: string, file: JevFileConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2) + '\n');
}

function takeProjectFlag(rest: string[]): { project: boolean; positional: string[] } {
  const positional = rest.filter((arg) => arg !== '-l' && arg !== '--project');
  return { project: positional.length !== rest.length, positional };
}

function tryReadFile(path: string, io: CliIo): JevFileConfig | undefined {
  try {
    return readConfigFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    io.err(`pi-jev: ignoring config at ${path} (${(error as Error).message})`);
    return undefined;
  }
}

export function valueAt(config: unknown, path: string): unknown {
  const record = config as Record<string, unknown>;
  const [section, key] = path.split('.');
  if (!key) return record[section];
  return (record[section] as Record<string, unknown> | undefined)?.[key];
}

export function formatValue(value: unknown): string {
  if (value === undefined) return 'unset';
  return String(value);
}

function show(io: CliIo): number {
  const global = tryReadFile(io.globalPath, io);
  const project = tryReadFile(io.projectPath, io);
  const config = configFromEnv(io.env, mergeConfigFiles(global, project));
  const width = Math.max(...CONFIG_KEYS.map((key) => key.path.length));
  for (const meta of CONFIG_KEYS) {
    const source = io.env[meta.env ?? '']?.trim()
      ? 'env'
      : getPath(project ?? {}, meta.path) !== undefined
        ? 'project'
        : getPath(global ?? {}, meta.path) !== undefined
          ? 'global'
          : 'default';
    io.out(`${meta.path.padEnd(width)} = ${formatValue(valueAt(config, meta.path)).padEnd(28)} # ${source}`);
  }
  io.out(`${'apiKey'.padEnd(width)} = ${config.apiKey ? 'set' : 'unset'}${''.padEnd(23)} # env only`);
  if (!config.routing.cheap && !config.routing.strong) {
    io.err('# routing is disabled: set routing.cheap (or routing.strong) to enable it');
  }
  return 0;
}

/** Runs the CLI against injectable IO. Returns the process exit code. */
export function runCli(argv: readonly string[], io: CliIo): number {
  const [cmd, sub, ...rest] = argv;
  if (cmd === undefined || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    io.out(USAGE);
    return 0;
  }
  if (cmd !== 'config') {
    io.err(`unknown command "${cmd}"`);
    io.err(USAGE);
    return 1;
  }
  try {
    if (sub === undefined) return show(io);

    // Actions: `pi-jev config set|get|unset <key> [value] [-l]`
    if (sub === 'set') {
      const { project, positional } = takeProjectFlag(rest);
      const [keyPath, ...valueParts] = positional;
      const meta = keyMeta(keyPath ?? '');
      if (!meta) {
        io.err(`unknown key "${keyPath}" (API keys are env-only). Run 'pi-jev config keys' to list valid keys.`);
        return 1;
      }
      const raw = valueParts.join(' ');
      if (!raw.trim()) {
        io.err(`usage: pi-jev config set ${meta.path} <value>`);
        return 1;
      }
      const value = coerce(meta, raw);
      const targetPath = project ? io.projectPath : io.globalPath;
      const file = readOrInit(targetPath);
      setPath(file, meta.path, value);
      saveFile(targetPath, file);
      io.out(`set ${meta.path} = ${String(value)} (${project ? 'project' : 'global'}: ${targetPath})`);
      return 0;
    }

    if (sub === 'get' || sub === 'unset') {
      const { project, positional } = takeProjectFlag(rest);
      const meta = keyMeta(positional[0] ?? '');
      if (!meta) {
        io.err(`unknown key "${positional[0]}" (API keys are env-only). Run 'pi-jev config keys' to list valid keys.`);
        return 1;
      }
      const targetPath = project ? io.projectPath : io.globalPath;
      if (sub === 'get') {
        const config = loadConfig({ env: io.env, globalPath: io.globalPath, projectPath: io.projectPath, warn: io.err });
        io.out(formatValue(valueAt(config, meta.path)));
        return 0;
      }
      const file = readOrInit(targetPath);
      if (deletePath(file, meta.path)) {
        saveFile(targetPath, file);
        io.out(`unset ${meta.path} (${project ? 'project' : 'global'}: ${targetPath})`);
      } else {
        io.out(`${meta.path} is not set (${project ? 'project' : 'global'})`);
      }
      return 0;
    }

    if (sub === 'path') {
      const { project } = takeProjectFlag(rest);
      io.out(project ? io.projectPath : io.globalPath);
      return 0;
    }

    if (sub === 'keys') {
      const width = Math.max(...CONFIG_KEYS.map((key) => key.path.length));
      for (const meta of CONFIG_KEYS) {
        io.out(`${meta.path.padEnd(width)}  ${meta.type.padEnd(7)} ${meta.env ? `env: ${meta.env.padEnd(26)} ` : ''}${meta.description}`);
      }
      return 0;
    }

    // Shorthand: `pi-jev config <key>` = get
    const meta = keyMeta(sub);
    if (!meta) {
      io.err(`unknown key "${sub}" (API keys are env-only). Run 'pi-jev config keys' to list valid keys.`);
      return 1;
    }
    const config = loadConfig({ env: io.env, globalPath: io.globalPath, projectPath: io.projectPath, warn: io.err });
    io.out(formatValue(valueAt(config, meta.path)));
    return 0;
  } catch (error) {
    io.err(`pi-jev: ${(error as Error).message}`);
    return 1;
  }
}

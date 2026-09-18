import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MODEL, SYSTEM_ONE_URL } from '../vendor/fast-jev-compaction/index.js';

/**
 * Shared configuration for the pi-jev extension suite. Values resolve from
 * layered sources, highest first: environment variables (prefix `JEVC_`), a
 * project file (`.pi/jev.json`), a global file (`~/.pi/agent/jev.json`), then
 * defaults. Each extension in `extensions/` reads the parts it needs;
 * enabling/disabling an extension itself is done with `pi config`, not env
 * flags.
 *
 * The `pi-jev config` CLI writes those files; API keys stay env-only.
 *
 * Jev can be reached through two transports with identical request/response
 * shapes (`{ model, state, questions }` → `{ answers }`):
 *
 * - `typesafe`   — the TypeSafe System One endpoint (`TYPESAFE_API_KEY`)
 * - `openrouter` — OpenRouter's Decisions API (`OPENROUTER_API_KEY`), which
 *   forwards to TypeSafe directly
 */

export type JevProvider = 'typesafe' | 'openrouter';

/** OpenRouter Decisions API (alpha). */
export const OPENROUTER_DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
/** Default Jev model slug on OpenRouter (versioned; override with `JEVC_MODEL`). */
export const OPENROUTER_JEV_MODEL = 'typesafe/jev-1.13';

/** Compaction feature options (consumed by src/compaction/*). */
export interface JevCompactionConfig {
  /** Transport selected via `JEVC_PROVIDER` or auto-detected from keys. */
  provider: JevProvider;
  /** API key for the selected transport (from `JEVC_API_KEY` or the transport's own variable). */
  apiKey: string;
  /** Resolved Jev model slug (already provider-specific). */
  model: string;
  /** Resolved endpoint URL. */
  baseUrl: string;
  /** Minimum keep probability for a call or result to stay verbatim. */
  keepThreshold: number;
  /** Band under `keepThreshold` where a confident low-staleness score still keeps a result. */
  borderline: number;
  /** Newest messages within the summarized span that are never touched. */
  preserveRecentMessages: number;
  /** Characters of a dropped tool result retained before its note. */
  truncateHeadChars: number;
  /** Minimum estimated span reduction, or the feature falls back to default compaction. */
  minReduction: number;
  /** Estimated token ceiling for the Jev state. */
  maxStateTokens: number;
  /** Estimated ceiling for state plus one batch of questions. */
  maxRequestTokens: number;
  /** Set via `JEVC_DISABLED` to bypass the hooks entirely (all features). */
  disabled: boolean;
}

/** Model-routing feature options (consumed by src/routing/*). */
export interface RoutingConfig {
  /** Easy-request target, `"provider/model-id"`. Routing is enabled when cheap or strong is set. */
  cheap: string | undefined;
  /** Hard-request target, `"provider/model-id"`; optional. */
  strong: string | undefined;
  /** Difficulty level (0..2) at or below which the cheap model is used. */
  easyMax: number;
  /** Difficulty level (0..2) at or above which the strong model is used. */
  hardMin: number;
  /** Minimum Jev confidence to act on a decision. */
  minConfidence: number;
}

export interface JevConfig extends JevCompactionConfig {
  routing: RoutingConfig;
}

const DEFAULTS = {
  keepThreshold: 0.5,
  borderline: 0.1,
  /** Small: pi already excludes the newest ~20k tokens from the span. */
  preserveRecentMessages: 3,
  truncateHeadChars: 300,
  minReduction: 0.15,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  easyMax: 0.5,
  hardMin: 1.5,
  minConfidence: 0.6,
};

function number(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function flag(env: Record<string, string | undefined>, key: string): boolean {
  return /^(1|true|yes)$/i.test(env[key] ?? '');
}

/** Boolean with source precedence: an explicitly set env value (even `0`) wins over the file. */
function layeredFlag(env: Record<string, string | undefined>, key: string, fileValue: boolean | undefined): boolean {
  const raw = env[key]?.trim();
  if (raw) return /^(1|true|yes)$/i.test(raw);
  return fileValue ?? false;
}

/**
 * Picks the transport: explicit `JEVC_PROVIDER` wins; otherwise TypeSafe when
 * its key is present, OpenRouter when only `OPENROUTER_API_KEY` is present,
 * and `typesafe` otherwise. `JEVC_API_KEY` alone does not influence the
 * choice (it could belong to either transport); set `JEVC_PROVIDER` to use it
 * with OpenRouter.
 */
function resolveProvider(env: Record<string, string | undefined>): JevProvider {
  const explicit = env.JEVC_PROVIDER?.trim().toLowerCase();
  if (explicit === 'typesafe' || explicit === 'openrouter') return explicit;
  if ((env.TYPESAFE_API_KEY ?? '').trim()) return 'typesafe';
  if ((env.OPENROUTER_API_KEY ?? '').trim()) return 'openrouter';
  return 'typesafe';
}

function keyFor(provider: JevProvider, env: Record<string, string | undefined>): string {
  const own = provider === 'openrouter' ? env.OPENROUTER_API_KEY : env.TYPESAFE_API_KEY;
  return env.JEVC_API_KEY?.trim() || own?.trim() || '';
}

/** File-based configuration layer; every field is optional. API keys never live here. */
export interface JevFileConfig {
  provider?: JevProvider;
  model?: string;
  baseUrl?: string;
  disabled?: boolean;
  routing?: {
    cheap?: string;
    strong?: string;
    easyMax?: number;
    hardMin?: number;
    minConfidence?: number;
  };
  compaction?: {
    keepThreshold?: number;
    borderline?: number;
    preserveRecentMessages?: number;
    truncateHeadChars?: number;
    minReduction?: number;
    maxStateTokens?: number;
    maxRequestTokens?: number;
  };
}

/** Metadata for one configurable key; drives the `pi-jev config` CLI. */
export interface ConfigKeyMeta {
  path: string;
  type: 'string' | 'number' | 'boolean';
  env?: string;
  default?: string | number | boolean;
  description: string;
}

/**
 * All user-facing keys. `apiKey` is deliberately absent (env-only), and the
 * routing thresholds (easyMax/hardMin/minConfidence) stay internal defaults —
 * still tunable through `JEVC_ROUTE_*` env vars, but not exposed here.
 */
export const CONFIG_KEYS: readonly ConfigKeyMeta[] = [
  { path: 'provider', type: 'string', env: 'JEVC_PROVIDER', description: 'Jev transport: typesafe or openrouter' },
  { path: 'model', type: 'string', env: 'JEVC_MODEL', description: 'Jev model slug (e.g. typesafe/jev-1.13 on OpenRouter)' },
  { path: 'baseUrl', type: 'string', env: 'JEVC_BASE_URL', description: 'Jev endpoint URL' },
  { path: 'disabled', type: 'boolean', env: 'JEVC_DISABLED', default: false, description: 'Bypass all pi-jev hooks' },
  { path: 'routing.cheap', type: 'string', env: 'JEVC_ROUTE_CHEAP', description: '"provider/model-id" for easy requests (enables routing)' },
  { path: 'routing.strong', type: 'string', env: 'JEVC_ROUTE_STRONG', description: '"provider/model-id" for hard requests (optional)' },
  { path: 'compaction.keepThreshold', type: 'number', env: 'JEVC_KEEP_THRESHOLD', default: DEFAULTS.keepThreshold, description: 'Minimum keep probability for verbatim retention' },
  { path: 'compaction.borderline', type: 'number', env: 'JEVC_BORDERLINE', default: DEFAULTS.borderline, description: 'Band where a confident low-staleness score still keeps a result' },
  { path: 'compaction.preserveRecentMessages', type: 'number', env: 'JEVC_PRESERVE_RECENT', default: DEFAULTS.preserveRecentMessages, description: 'Newest messages within the summarized span that are never touched' },
  { path: 'compaction.truncateHeadChars', type: 'number', env: 'JEVC_TRUNCATE_HEAD', default: DEFAULTS.truncateHeadChars, description: 'Characters of a dropped tool result retained before its note' },
  { path: 'compaction.minReduction', type: 'number', env: 'JEVC_MIN_REDUCTION', default: DEFAULTS.minReduction, description: 'Minimum estimated span reduction, else default compaction' },
  { path: 'compaction.maxStateTokens', type: 'number', env: 'JEVC_MAX_STATE_TOKENS', default: DEFAULTS.maxStateTokens, description: 'Estimated token ceiling for the Jev state' },
  { path: 'compaction.maxRequestTokens', type: 'number', env: 'JEVC_MAX_REQUEST_TOKENS', default: DEFAULTS.maxRequestTokens, description: 'Estimated ceiling for state plus one batch of questions' },
];

/** Default config file locations, mirroring pi's own settings layout. */
export function defaultConfigPaths(): { globalPath: string; projectPath: string } {
  return {
    globalPath: join(homedir(), '.pi', 'agent', 'jev.json'),
    projectPath: join(process.cwd(), '.pi', 'jev.json'),
  };
}

/** Reads and parses one config file. Throws on missing or malformed JSON. */
export function readConfigFile(path: string): JevFileConfig {
  const raw = readFileSync(path, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`config at ${path} must be a JSON object`);
  }
  return parsed as JevFileConfig;
}

function readTolerant(path: string, scope: string, warn: (message: string) => void): JevFileConfig | undefined {
  try {
    return readConfigFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    warn(`pi-jev: ignoring ${scope} config at ${path} (${(error as Error).message})`);
    return undefined;
  }
}

export function mergeConfigFiles(global?: JevFileConfig, project?: JevFileConfig): JevFileConfig | undefined {
  if (!global) return project;
  if (!project) return global;
  return {
    ...global,
    ...project,
    routing: { ...global.routing, ...project.routing },
    compaction: { ...global.compaction, ...project.compaction },
  };
}

/** Resolves the full config: env > project file > global file > defaults. */
export function configFromEnv(
  env: Record<string, string | undefined> = process.env,
  file?: JevFileConfig,
): JevConfig {
  const explicit = env.JEVC_PROVIDER?.trim().toLowerCase();
  const provider: JevProvider = explicit === 'typesafe' || explicit === 'openrouter'
    ? explicit
    : file?.provider === 'typesafe' || file?.provider === 'openrouter'
      ? file.provider
      : resolveProvider(env);
  return {
    provider,
    apiKey: keyFor(provider, env),
    model: env.JEVC_MODEL?.trim() || file?.model?.trim()
      || (provider === 'openrouter' ? OPENROUTER_JEV_MODEL : DEFAULT_MODEL),
    baseUrl: env.JEVC_BASE_URL?.trim() || file?.baseUrl?.trim()
      || (provider === 'openrouter' ? OPENROUTER_DECISIONS_URL : SYSTEM_ONE_URL),
    keepThreshold: number(env, 'JEVC_KEEP_THRESHOLD', file?.compaction?.keepThreshold ?? DEFAULTS.keepThreshold),
    borderline: number(env, 'JEVC_BORDERLINE', file?.compaction?.borderline ?? DEFAULTS.borderline),
    preserveRecentMessages: Math.max(
      0,
      Math.floor(number(env, 'JEVC_PRESERVE_RECENT', file?.compaction?.preserveRecentMessages ?? DEFAULTS.preserveRecentMessages)),
    ),
    truncateHeadChars: Math.max(
      0,
      Math.floor(number(env, 'JEVC_TRUNCATE_HEAD', file?.compaction?.truncateHeadChars ?? DEFAULTS.truncateHeadChars)),
    ),
    minReduction: number(env, 'JEVC_MIN_REDUCTION', file?.compaction?.minReduction ?? DEFAULTS.minReduction),
    maxStateTokens: Math.max(1, number(env, 'JEVC_MAX_STATE_TOKENS', file?.compaction?.maxStateTokens ?? DEFAULTS.maxStateTokens)),
    maxRequestTokens: Math.max(1, number(env, 'JEVC_MAX_REQUEST_TOKENS', file?.compaction?.maxRequestTokens ?? DEFAULTS.maxRequestTokens)),
    disabled: layeredFlag(env, 'JEVC_DISABLED', file?.disabled),
    routing: {
      cheap: env.JEVC_ROUTE_CHEAP?.trim() || file?.routing?.cheap?.trim() || undefined,
      strong: env.JEVC_ROUTE_STRONG?.trim() || file?.routing?.strong?.trim() || undefined,
      easyMax: number(env, 'JEVC_ROUTE_EASY_MAX', file?.routing?.easyMax ?? DEFAULTS.easyMax),
      hardMin: number(env, 'JEVC_ROUTE_HARD_MIN', file?.routing?.hardMin ?? DEFAULTS.hardMin),
      minConfidence: number(env, 'JEVC_ROUTE_MIN_CONFIDENCE', file?.routing?.minConfidence ?? DEFAULTS.minConfidence),
    },
  };
}

/** Loads config files and env into a full `JevConfig`. Malformed files warn and are skipped. */
export function loadConfig(
  opts: {
    env?: Record<string, string | undefined>;
    globalPath?: string;
    projectPath?: string;
    warn?: (message: string) => void;
  } = {},
): JevConfig {
  const paths = { ...defaultConfigPaths(), ...opts };
  const warn = opts.warn ?? ((message: string) => console.warn(message));
  const file = mergeConfigFiles(
    readTolerant(paths.globalPath, 'global', warn),
    readTolerant(paths.projectPath, 'project', warn),
  );
  return configFromEnv(opts.env ?? process.env, file);
}

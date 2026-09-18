import { DEFAULT_MODEL, SYSTEM_ONE_URL } from '../vendor/fast-jev-compaction/index.js';

/**
 * Shared configuration for the pi-jev extension suite, resolved from
 * environment variables (prefix `JEVC_`). Each extension in `extensions/`
 * reads the parts it needs; enabling/disabling an extension itself is done
 * with `pi config`, not env flags.
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

export function configFromEnv(env: Record<string, string | undefined> = process.env): JevConfig {
  const provider = resolveProvider(env);
  return {
    provider,
    apiKey: keyFor(provider, env),
    model: env.JEVC_MODEL?.trim() || (provider === 'openrouter' ? OPENROUTER_JEV_MODEL : DEFAULT_MODEL),
    baseUrl: env.JEVC_BASE_URL?.trim() || (provider === 'openrouter' ? OPENROUTER_DECISIONS_URL : SYSTEM_ONE_URL),
    keepThreshold: number(env, 'JEVC_KEEP_THRESHOLD', DEFAULTS.keepThreshold),
    borderline: number(env, 'JEVC_BORDERLINE', DEFAULTS.borderline),
    preserveRecentMessages: Math.max(
      0,
      Math.floor(number(env, 'JEVC_PRESERVE_RECENT', DEFAULTS.preserveRecentMessages)),
    ),
    truncateHeadChars: Math.max(
      0,
      Math.floor(number(env, 'JEVC_TRUNCATE_HEAD', DEFAULTS.truncateHeadChars)),
    ),
    minReduction: number(env, 'JEVC_MIN_REDUCTION', DEFAULTS.minReduction),
    maxStateTokens: Math.max(1, number(env, 'JEVC_MAX_STATE_TOKENS', DEFAULTS.maxStateTokens)),
    maxRequestTokens: Math.max(1, number(env, 'JEVC_MAX_REQUEST_TOKENS', DEFAULTS.maxRequestTokens)),
    disabled: flag(env, 'JEVC_DISABLED'),
    routing: {
      cheap: env.JEVC_ROUTE_CHEAP?.trim() || undefined,
      strong: env.JEVC_ROUTE_STRONG?.trim() || undefined,
      easyMax: number(env, 'JEVC_ROUTE_EASY_MAX', DEFAULTS.easyMax),
      hardMin: number(env, 'JEVC_ROUTE_HARD_MIN', DEFAULTS.hardMin),
      minConfidence: number(env, 'JEVC_ROUTE_MIN_CONFIDENCE', DEFAULTS.minConfidence),
    },
  };
}

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { compact } from '@earendil-works/pi-coding-agent';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { EvalCase } from './cases.js';
import { redact } from './replay.js';

export const PI_SUMMARY_CACHE = join(import.meta.dirname, '..', '.cache', 'pi-summary');

/**
 * An OpenRouter model for pi's own summariser. Routing is restricted to
 * providers that do not retain prompts, like the replay client, because the
 * span goes out with full tool outputs.
 */
export function openRouterModel(id: string, promptPrice: number, completionPrice: number): Model<Api> {
  return {
    id,
    name: id,
    api: 'openai-completions',
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: promptPrice, output: completionPrice, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 32_000,
    compat: { openRouterRouting: { data_collection: 'deny' } },
  } as unknown as Model<Api>;
}

/** Redacts every string in a message, whatever field it sits in. */
function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map(redactDeep) as unknown as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item)])) as T;
  }
  return value;
}

export interface PiSummary {
  summary: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  cached: boolean;
}

/**
 * pi's default compaction of one case's span, by pi's own `compact()` and
 * prompts. The previous summary is dropped: in chained cases it is a
 * fixed-size placeholder, and pi would try to update it.
 */
export async function piSummary(
  evalCase: EvalCase,
  options: { model: Model<Api>; apiKey: string; offline?: boolean },
): Promise<PiSummary> {
  const preparation = {
    ...evalCase.preparation,
    previousSummary: undefined,
    messagesToSummarize: redactDeep(evalCase.preparation.messagesToSummarize),
    turnPrefixMessages: redactDeep(evalCase.preparation.turnPrefixMessages),
  };
  const key = createHash('sha256')
    .update(options.model.id)
    .update(evalCase.id)
    .update(JSON.stringify(preparation.messagesToSummarize))
    .update(JSON.stringify(preparation.turnPrefixMessages))
    .digest('hex');
  const path = join(PI_SUMMARY_CACHE, `${key}.json`);
  try {
    return { ...(JSON.parse(readFileSync(path, 'utf8')) as PiSummary), cached: true };
  } catch {
    // miss
  }
  if (options.offline) throw new Error(`no cached pi summary for ${evalCase.id}`);

  const result = await compact(preparation, options.model, options.apiKey);
  const value: PiSummary = {
    summary: result.summary,
    inputTokens: result.usage?.input ?? 0,
    outputTokens: result.usage?.output ?? 0,
    costUsd: result.usage?.cost?.total ?? 0,
    cached: false,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
  return value;
}

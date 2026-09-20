import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  JevAsker,
  JevQuestions,
  JevResponse,
  JevState,
} from '../../src/vendor/fast-jev-compaction/index.js';

export const CACHE_DIR = join(import.meta.dirname, '..', '.cache', 'jev');

export interface AskerStats {
  hits: number;
  misses: number;
  /** Tokens actually billed by live requests (cache hits cost nothing). */
  inputTokens: number;
  outputTokens: number;
  /** Latency of every request, live or as first measured for a cache hit. */
  latenciesMs: number[];
}

interface Entry {
  response: JevResponse;
  ms: number;
}

const RETRYABLE = /\((429|5\d\d)\)|fetch failed|ECONNRESET|ETIMEDOUT/;

/**
 * Caches Jev answers on disk by request content, so the same span can be
 * re-decided under different thresholds without another API call. Only answers
 * and usage are stored; the key is a hash, so no session text lands on disk.
 */
export class CachingAsker implements JevAsker {
  readonly stats: AskerStats = { hits: 0, misses: 0, inputTokens: 0, outputTokens: 0, latenciesMs: [] };
  private inFlight = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly inner: JevAsker | undefined,
    /** Anything that changes answers besides the request body (model, endpoint). */
    private readonly salt: string,
    private readonly options: { offline?: boolean; concurrency?: number } = {},
  ) {}

  private path(state: JevState, questions: JevQuestions): string {
    const key = createHash('sha256')
      .update(this.salt)
      .update('\0')
      .update(JSON.stringify(state))
      .update('\0')
      .update(JSON.stringify(questions))
      .digest('hex');
    return join(CACHE_DIR, key.slice(0, 2), `${key}.json`);
  }

  private async slot(): Promise<() => void> {
    const limit = this.options.concurrency ?? 4;
    if (this.inFlight >= limit) await new Promise<void>(resolve => this.waiting.push(resolve));
    this.inFlight += 1;
    return () => {
      this.inFlight -= 1;
      this.waiting.shift()?.();
    };
  }

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    const path = this.path(state, questions);
    try {
      const entry = JSON.parse(readFileSync(path, 'utf8')) as Entry;
      this.stats.hits += 1;
      this.stats.latenciesMs.push(entry.ms);
      return entry.response;
    } catch {
      // miss
    }
    if (this.options.offline || !this.inner) {
      throw new Error('Jev cache miss while offline (run without --offline to fetch)');
    }

    const release = await this.slot();
    try {
      for (let attempt = 0; ; attempt++) {
        const started = Date.now();
        try {
          const response = await this.inner.ask(state, questions);
          const ms = Date.now() - started;
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, JSON.stringify({ response, ms } satisfies Entry));
          this.stats.misses += 1;
          this.stats.inputTokens += response.usage?.input_tokens ?? 0;
          this.stats.outputTokens += response.usage?.output_tokens ?? 0;
          this.stats.latenciesMs.push(ms);
          return response;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (attempt >= 3 || !RETRYABLE.test(message)) throw error;
          await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
        }
      }
    } finally {
      release();
    }
  }
}

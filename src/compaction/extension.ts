import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Usage } from '@earendil-works/pi-ai';
import {
  JevClient,
  estimateTokens,
  goalFromMessages,
  type JevAsker,
} from '../vendor/fast-jev-compaction/index.js';
import { configFromEnv, type JevCompactionConfig } from '../shared/config.js';
import { convertMessages } from './convert.js';
import { compactWithJev, type JevCompactionStats } from './jev.js';
import { renderSummary, renderTranscript } from './summarize.js';

/** The slice of `SessionBeforeCompactEvent` the compaction core needs. */
export interface CompactionSpanInput {
  messagesToSummarize: readonly AgentMessage[];
  turnPrefixMessages: readonly AgentMessage[];
  previousSummary?: string;
  customInstructions?: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}

export interface JevDetails {
  engine: 'jev';
  stats: JevCompactionStats;
  decisions: Array<{
    id: string;
    tool: string;
    action: string;
    reason: string;
    keepCall: number;
    keepResult: number;
  }>;
}

export type JevCompactionRun =
  | {
      ok: true;
      compaction: {
        summary: string;
        firstKeptEntryId: string;
        tokensBefore: number;
        estimatedTokensAfter: number;
        usage?: Usage;
        details: JevDetails;
      };
      reduction: number;
    }
  | {
      ok: false;
      reason: 'empty-span' | 'low-reduction';
      reduction: number;
    };

function toUsage(jev: { input: number; output: number }): Usage {
  const total = jev.input + jev.output;
  return {
    input: jev.input,
    output: jev.output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: total,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * Core pipeline, separated from the extension hook so tests can drive it with
 * a fake `JevAsker`. Converts the span, asks Jev which tool calls and results
 * still matter, and renders the surviving transcript verbatim as the
 * compaction summary. Returns `ok: false` when the span is empty or the
 * estimated reduction is below `config.minReduction` (caller falls back to
 * pi's default compaction). Throws when Jev fails; the caller decides.
 */
export async function runJevCompaction(
  input: CompactionSpanInput,
  asker: JevAsker,
  config: JevCompactionConfig,
): Promise<JevCompactionRun> {
  const span = [...input.messagesToSummarize, ...input.turnPrefixMessages];
  const converted = convertMessages(span);
  if (converted.length === 0) {
    return { ok: false, reason: 'empty-span', reduction: 0 };
  }

  const goal = input.customInstructions?.trim() || goalFromMessages(converted);
  const outcome = await compactWithJev(converted, asker, config, goal);

  const summary = renderSummary(outcome.messages, {
    goal,
    previousSummary: input.previousSummary,
    droppedCalls: outcome.stats.callsDropped,
    truncatedResults: outcome.stats.resultsDropped,
  });

  // Size estimation in one consistent unit: render the original and the
  // compacted span with the same renderer. The previous summary is a fixed
  // cost on both sides, so the reduction ignores it.
  const spanTokens = estimateTokens(renderTranscript(converted));
  const keptTokens = estimateTokens(renderTranscript(outcome.messages));
  const summaryTokens = estimateTokens(summary);
  const reduction = spanTokens === 0 ? 0 : 1 - keptTokens / spanTokens;

  if (reduction < config.minReduction) {
    return { ok: false, reason: 'low-reduction', reduction };
  }

  return {
    ok: true,
    reduction,
    compaction: {
      summary,
      firstKeptEntryId: input.firstKeptEntryId,
      tokensBefore: input.tokensBefore,
      estimatedTokensAfter: Math.max(summaryTokens, input.tokensBefore - spanTokens + summaryTokens),
      usage: outcome.stats.jevUsage ? toUsage(outcome.stats.jevUsage) : undefined,
      details: {
        engine: 'jev',
        stats: outcome.stats,
        decisions: outcome.decisions.map(decision => ({
          id: decision.id,
          tool: decision.tool,
          action: decision.action,
          reason: decision.reason,
          keepCall: decision.keepCall,
          keepResult: decision.keepResult,
        })),
      },
    },
  };
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error('aborted'));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The extension: on `session_before_compact`, replace pi's LLM-generated
 * summary with a Jev-compacted verbatim transcript. Any failure, abort, or
 * insufficient reduction falls back to pi's default compaction.
 */
export default function (pi: ExtensionAPI): void {
  const config = configFromEnv();

  pi.on('session_start', async (_event, ctx) => {
    if (config.disabled) return;
    ctx.ui.notify(
      config.apiKey
        ? `jev-compaction active (Jev via ${config.provider}): stale tool outputs are dropped, not summarized`
        : 'jev-compaction: set TYPESAFE_API_KEY or OPENROUTER_API_KEY (or JEVC_API_KEY/JEVC_PROVIDER) to enable; using default compaction',
      config.apiKey ? 'info' : 'warning',
    );
  });

  pi.on('session_before_compact', async (event, ctx) => {
    if (config.disabled || !config.apiKey) return;
    if (event.signal?.aborted) return;

    const { preparation, customInstructions } = event;
    const asker = new JevClient({
      apiKey: config.apiKey,
      model: config.model,
      baseUrl: config.baseUrl,
    });

    try {
      const run = await raceAbort(
        runJevCompaction(
          {
            messagesToSummarize: preparation.messagesToSummarize,
            turnPrefixMessages: preparation.turnPrefixMessages,
            previousSummary: preparation.previousSummary,
            customInstructions,
            firstKeptEntryId: preparation.firstKeptEntryId,
            tokensBefore: preparation.tokensBefore,
          },
          asker,
          config,
        ),
        event.signal,
      );

      if (!run.ok) {
        if (run.reason === 'low-reduction') {
          ctx.ui.notify(
            `jev-compaction: only ${(run.reduction * 100).toFixed(0)}% reduction; using default compaction`,
            'warning',
          );
        }
        return; // undefined result -> pi runs its default compaction
      }

      const stats = run.compaction.details.stats;
      ctx.ui.notify(
        `jev-compaction: ${stats.calls - stats.pinned} calls scored — kept ${stats.kept - stats.pinned}, ` +
          `truncated ${stats.resultsDropped}, dropped ${stats.callsDropped} ` +
          `(${stats.requests} Jev req, ${(run.reduction * 100).toFixed(0)}% smaller, ${stats.ms} ms)`,
        'info',
      );
      return { compaction: run.compaction };
    } catch (error) {
      if (event.signal?.aborted) return;
      ctx.ui.notify(
        `jev-compaction failed (${errorMessage(error)}); using default compaction`,
        'error',
      );
      return;
    }
  });
}

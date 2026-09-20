import { runJevCompaction, type CompactionSpanInput, type JevDetails } from '../../src/compaction/extension.js';
import { convertMessages } from '../../src/compaction/convert.js';
import type { JevCompactionStats } from '../../src/compaction/jev.js';
import { renderTranscript } from '../../src/compaction/summarize.js';
import type { JevCompactionConfig } from '../../src/shared/config.js';
import {
  collectToolCalls,
  estimateTokens,
  goalFromMessages,
  type CallAction,
  type JevAsker,
  type Message,
  type ToolCall,
} from '../../src/vendor/fast-jev-compaction/index.js';
import type { EvalCase } from './cases.js';
import { labelCase, type CaseLabels } from './labels.js';
import type { Outcome } from './policies.js';

export interface Prepared {
  evalCase: EvalCase;
  converted: Message[];
  calls: ToolCall[];
  goal: string;
  spanTokens: number;
  labels: CaseLabels;
  input: CompactionSpanInput;
}

/** Converts the span and labels it with what the agent did afterwards. */
export function prepare(evalCase: EvalCase): Prepared | undefined {
  const converted = convertMessages(evalCase.span);
  if (converted.length === 0) return undefined;
  const calls = collectToolCalls(converted, 0);
  const { preparation } = evalCase;
  return {
    evalCase,
    converted,
    calls,
    goal: goalFromMessages(converted),
    spanTokens: estimateTokens(renderTranscript(converted)),
    labels: labelCase(converted, calls, evalCase.tail, evalCase.future),
    input: {
      messagesToSummarize: preparation.messagesToSummarize,
      turnPrefixMessages: preparation.turnPrefixMessages,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
    },
  };
}

export interface JevRun {
  outcome: Outcome;
  decisions: JevDetails['decisions'];
  stats: JevCompactionStats;
  /** Reduction as the extension computes it; below `minReduction` production falls back to pi. */
  productionReduction: number;
}

/**
 * Runs the production pipeline. `minReduction` is forced to 0 so the decisions
 * are always available; the caller applies the real threshold to
 * `productionReduction` to count fallbacks.
 */
export async function runJev(
  prepared: Prepared,
  asker: JevAsker,
  config: JevCompactionConfig,
): Promise<JevRun> {
  const run = await runJevCompaction(prepared.input, asker, { ...config, minReduction: 0 });
  if (!run.ok) throw new Error(`pipeline returned ${run.reason}`);
  const { compaction } = run;
  const actions = new Map<string, CallAction>(
    compaction.details.decisions.map(decision => [decision.id, decision.action as CallAction]),
  );
  return {
    decisions: compaction.details.decisions,
    outcome: { actions, summary: compaction.summary, summaryTokens: estimateTokens(compaction.summary) },
    stats: compaction.details.stats,
    productionReduction: run.reduction,
  };
}

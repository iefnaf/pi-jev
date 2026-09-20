import { createHash } from 'node:crypto';
import { applyJevDecisions, type DecisionOutcome } from '../../src/compaction/decision.js';
import { renderSummary } from '../../src/compaction/summarize.js';
import {
  estimateTokens,
  type CallAction,
  type Message,
  type ToolCall,
} from '../../src/vendor/fast-jev-compaction/index.js';

/** What a compaction policy leaves in the context, whoever produced it. */
export interface Outcome {
  actions: Map<string, CallAction>;
  summary: string;
  summaryTokens: number;
}

export type BaselineName = 'keep-all' | 'drop-all' | 'recent' | 'small-first' | 'large-first' | 'random';

/** Baselines that fill a token budget by ranking calls. */
/**
 * `large-first` is a diagnostic, not a candidate: larger results hold more
 * distinctive strings, so the labels favour them regardless of relevance, and
 * this baseline shows how much of a score is that size effect.
 */
export const BUDGETED: readonly BaselineName[] = ['recent', 'small-first', 'large-first', 'random'];

function asDecision(call: ToolCall, action: CallAction): DecisionOutcome {
  return {
    id: call.id,
    tool: call.tool,
    keepCall: 1,
    keepResult: action === 'keep' ? 1 : 0,
    action,
    reason: action === 'keep' ? 'kept' : 'result_dropped',
    boundary: false,
    guarded: false,
    missing: false,
  };
}

/**
 * Renders a per-call action plan exactly as the extension would: same
 * truncation, same summary wrapper, so token counts compare like for like.
 */
export function materialize(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  actions: Map<string, CallAction>,
  goal: string,
  headChars: number,
): Outcome {
  const decisions = calls.map(call => asDecision(call, actions.get(call.id) ?? 'keep'));
  const kept = applyJevDecisions(messages, decisions, calls, headChars);
  const count = (action: CallAction): number => decisions.filter(d => d.action === action).length;
  const summary = renderSummary(kept, {
    goal,
    droppedCalls: count('drop_call'),
    truncatedResults: count('drop_result'),
  });
  return { actions, summary, summaryTokens: estimateTokens(summary) };
}

function unit(text: string): number {
  return createHash('sha1').update(text).digest().readUInt32BE(0) / 0xffffffff;
}

/** Highest priority first: the calls a policy would rather keep verbatim. */
function ranking(name: BaselineName, calls: readonly ToolCall[], seed: string): ToolCall[] {
  const ordered = [...calls];
  switch (name) {
    case 'recent':
      return ordered.sort((a, b) => b.resultIndex - a.resultIndex);
    case 'small-first':
      return ordered.sort((a, b) => a.resultChars - b.resultChars);
    case 'large-first':
      return ordered.sort((a, b) => b.resultChars - a.resultChars);
    case 'random':
      return ordered.sort((a, b) => unit(`${seed}${a.id}`) - unit(`${seed}${b.id}`));
    default:
      return ordered;
  }
}

/**
 * A baseline at a token budget, tiered along its ranking: the top results stay
 * verbatim, the next ones keep only their call and a truncated head, the rest
 * disappear entirely. Verbatim results are filled first, then heads with what
 * budget remains, so it can reach the same low budgets Jev does by dropping
 * calls.
 */
export function runBaseline(
  name: BaselineName,
  messages: readonly Message[],
  calls: readonly ToolCall[],
  goal: string,
  headChars: number,
  budgetTokens: number,
  seed: string,
): Outcome {
  const build = (verbatim: number, heads: number, order: readonly ToolCall[]): Outcome => {
    const actions = new Map<string, CallAction>();
    order.forEach((call, rank) => {
      actions.set(
        call.id,
        rank < verbatim ? 'keep' : rank < verbatim + heads ? 'drop_result' : 'drop_call',
      );
    });
    return materialize(messages, calls, actions, goal, headChars);
  };
  /** Largest count in [0, max] whose outcome still fits the budget. */
  const largest = (max: number, fits: (count: number) => boolean): number => {
    let low = 0;
    let high = max;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fits(mid)) low = mid;
      else high = mid - 1;
    }
    return low;
  };

  if (name === 'keep-all') return build(calls.length, 0, calls);
  if (name === 'drop-all') return build(0, calls.length, calls);

  const order = ranking(name, calls, seed);
  const verbatim = largest(order.length, count => build(count, 0, order).summaryTokens <= budgetTokens);
  const heads = largest(
    order.length - verbatim,
    count => build(verbatim, count, order).summaryTokens <= budgetTokens,
  );
  return build(verbatim, heads, order);
}

/**
 * Upper bound: keeps exactly the calls the future shows were used, verbatim,
 * and drops everything else. No real policy can know this at compaction time.
 */
export function runOracle(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  goal: string,
  headChars: number,
  used: ReadonlySet<string>,
): Outcome {
  const actions = new Map<string, CallAction>(
    calls.map(call => [call.id, used.has(call.id) ? 'keep' : 'drop_call']),
  );
  return materialize(messages, calls, actions, goal, headChars);
}

/**
 * Tools whose output can be produced again by calling them (with the caveats
 * that state may have moved on and it costs a round trip). Anything else, such
 * as sub-agent runs, web fetches and questions to the user, is kept verbatim.
 */
export const REPRODUCIBLE_TOOLS: ReadonlySet<string> = new Set([
  'read', 'grep', 'find', 'ls', 'bash', 'fabric_exec', 'ctx_execute', 'hypa_read', 'hypa_grep', 'write', 'edit', 'nu',
]);

/**
 * A plain rule, no model call: keep every message and every tool call, cut the
 * output of reproducible tools to its head (short ones are untouched anyway),
 * and keep everything else whole.
 */
export function runMask(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  goal: string,
  headChars: number,
): Outcome {
  const actions = new Map<string, CallAction>(
    calls.map(call => [call.id, REPRODUCIBLE_TOOLS.has(call.tool) ? 'drop_result' : 'keep']),
  );
  return materialize(messages, calls, actions, goal, headChars);
}

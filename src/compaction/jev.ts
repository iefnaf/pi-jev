import {
  applyJevDecisions,
  batchCalls,
  boundaryCallId,
  decideCall,
  questionsFor,
  type DecisionOutcome,
} from './decision.js';
import {
  collectToolCalls,
  fitState,
  goalFromMessages,
  messageChars,
  resolveOptions,
  type JevAnswer,
  type JevAsker,
  type JevQuestions,
  type Message,
  type ToolCall,
} from '../vendor/fast-jev-compaction/index.js';
import type { JevCompactionConfig } from '../shared/config.js';

export interface JevCompactionStats {
  messagesBefore: number;
  messagesAfter: number;
  charsBefore: number;
  charsAfter: number;
  calls: number;
  kept: number;
  resultsDropped: number;
  callsDropped: number;
  /** Calls whose result sits at pi's cut boundary and was bounded, not dropped. */
  boundary: number;
  /** Borderline results kept because of a confident low-staleness score. */
  guarded: number;
  /** Calls whose answers were missing/malformed; kept conservatively. */
  missing: number;
  stateTokens: number;
  stateStage: string;
  requests: number;
  ms: number;
  jevUsage?: { input: number; output: number };
}

export interface JevCompactionOutcome {
  /** Compacted transcript; untouched messages are the input objects. */
  messages: Message[];
  decisions: DecisionOutcome[];
  stats: JevCompactionStats;
}

/**
 * Compacts the converted span with Jev: every tool call gets two `noul`
 * questions (keep the call, keep its result verbatim) plus one `score` question
 * (result staleness) whose confident answer can rescue a borderline result.
 * Batches run concurrently; the same fitted state is sent with each.
 *
 * Recency is pi's job: pi has already kept the newest
 * `compaction.keepRecentTokens` tokens out of the span, so nothing here is
 * pinned or excluded for being recent. The one exception is the call at the
 * cut boundary (`boundaryCallId`): it is scored like the rest, but a Jev
 * `drop_call` is softened to keeping the call and a bounded result head.
 */
export async function compactWithJev(
  messages: readonly Message[],
  asker: JevAsker,
  config: JevCompactionConfig,
  goal?: string,
): Promise<JevCompactionOutcome> {
  const started = Date.now();
  const resolvedGoal = goal?.trim() || goalFromMessages(messages);
  const resolved = resolveOptions({
    goal: resolvedGoal,
    keepThreshold: config.keepThreshold,
    preserveRecentMessages: 0,
    maxStateTokens: config.maxStateTokens,
    maxRequestTokens: config.maxRequestTokens,
    truncateHeadChars: config.truncateHeadChars,
  });

  const calls = collectToolCalls(messages, resolved.preserveRecentMessages);
  const boundary = boundaryCallId(messages, calls);
  const candidates = calls;

  const answers: Record<string, JevAnswer> = {};
  let stateTokens = 0;
  let stateStage = '';
  let batches: ToolCall[][] = [];
  let jevUsage: { input: number; output: number } | undefined;

  if (candidates.length > 0) {
    const fitted = fitState(messages, calls, resolved);
    stateTokens = fitted.tokens;
    stateStage = fitted.stage;
    batches = batchCalls(candidates, stateTokens, config.maxRequestTokens);
    const responses = await Promise.all(
      batches.map(async batch => {
        const questions: JevQuestions = Object.assign({}, ...batch.map(questionsFor));
        return asker.ask(fitted.state, questions);
      }),
    );
    for (const response of responses) {
      Object.assign(answers, response.answers);
      if (response.usage) {
        const input = response.usage.input_tokens ?? 0;
        const output = response.usage.output_tokens ?? 0;
        jevUsage = jevUsage
          ? { input: jevUsage.input + input, output: jevUsage.output + output }
          : { input, output };
      }
    }
  }

  const decisions = calls.map(call =>
    decideCall(call, answers, {
      keepThreshold: config.keepThreshold,
      borderline: config.borderline,
      boundary: call.id === boundary,
    }),
  );
  const kept = applyJevDecisions(messages, decisions, calls, resolved.truncateHeadChars);

  const count = (predicate: (decision: ReturnType<typeof decideCall>) => boolean): number =>
    decisions.filter(predicate).length;

  return {
    messages: kept,
    decisions,
    stats: {
      messagesBefore: messages.length,
      messagesAfter: kept.length,
      charsBefore: messages.reduce((sum, message) => sum + messageChars(message), 0),
      charsAfter: kept.reduce((sum, message) => sum + messageChars(message), 0),
      calls: calls.length,
      kept: count(decision => decision.action === 'keep'),
      resultsDropped: count(decision => decision.action === 'drop_result'),
      callsDropped: count(decision => decision.action === 'drop_call'),
      boundary: count(decision => decision.reason === 'boundary'),
      guarded: count(decision => decision.guarded),
      missing: count(decision => decision.missing),
      stateTokens,
      stateStage,
      requests: batches.length,
      ms: Date.now() - started,
      jevUsage,
    },
  };
}

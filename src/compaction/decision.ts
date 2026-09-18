import {
  estimateTokens,
  type CallAction,
  type JevAnswer,
  type JevQuestions,
  type Message,
  type ToolCall,
} from '../vendor/fast-jev-compaction/index.js';

/** Ordered staleness levels for the per-result `score` question. */
const STALENESS_LEVELS = ['needed', 'probably needed', 'uncertain', 'stale', 'very stale'] as const;

/** Tokens the request envelope (`model`, key names) adds around state and questions. */
const REQUEST_OVERHEAD_TOKENS = 20;

/**
 * The three questions asked about one tool call: two `noul` questions (keep
 * the call, keep its result verbatim) and one `score` question whose
 * confident answer can rescue a borderline result.
 */
export function questionsFor(call: ToolCall): JevQuestions {
  return {
    [`call_${call.id}`]: {
      type: 'noul',
      instructions: `Tool call ${call.id} (${call.tool}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next`,
    },
    [`result_${call.id}`]: {
      type: 'noul',
      instructions: `The full output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do`,
    },
    [`staleness_${call.id}`]: {
      type: 'score',
      instructions: `Rate how stale the output of tool call ${call.id} (${call.tool}) is for the ongoing work: level 0 means its contents are still needed verbatim, level ${STALENESS_LEVELS.length - 1} means clearly obsolete`,
      criteria: [...STALENESS_LEVELS],
    },
  };
}

/**
 * Splits candidate calls into batches whose questions, together with the
 * (always complete) state, fit one Jev request.
 */
export function batchCalls(
  calls: readonly ToolCall[],
  stateTokens: number,
  maxRequestTokens: number,
): ToolCall[][] {
  const budget = maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS;
  const batches: ToolCall[][] = [];
  let current: ToolCall[] = [];
  let currentTokens = 0;
  for (const call of calls) {
    const tokens = estimateTokens(JSON.stringify(questionsFor(call)));
    if (current.length > 0 && currentTokens + tokens > budget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    if (current.length === 0 && tokens > budget) {
      throw new Error(
        `state leaves no room for questions (~${stateTokens} of ${maxRequestTokens} tokens)`,
      );
    }
    current.push(call);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export interface DecisionOutcome {
  id: string;
  tool: string;
  keepCall: number;
  keepResult: number;
  action: CallAction;
  reason: 'pinned' | 'kept' | 'result_dropped' | 'call_dropped';
  pinned: boolean;
  /** Kept only because of a confident low-staleness score. */
  guarded: boolean;
  /** Answers missing or malformed; kept conservatively. */
  missing: boolean;
}

function noulOr(answers: Record<string, JevAnswer>, name: string): number | undefined {
  const answer = answers[name];
  if (
    answer === null ||
    typeof answer !== 'object' ||
    !('noul' in answer) ||
    typeof (answer as { noul?: unknown }).noul !== 'number' ||
    !Number.isFinite((answer as { noul: number }).noul)
  ) {
    return undefined;
  }
  return (answer as { noul: number }).noul;
}

function scoreAnswer(
  answers: Record<string, JevAnswer>,
  name: string,
): { score: number; confidence: number } | undefined {
  const answer = answers[name];
  if (
    answer === null ||
    typeof answer !== 'object' ||
    !('score' in answer) ||
    typeof (answer as { score?: unknown }).score !== 'number' ||
    !Number.isFinite((answer as { score: number }).score)
  ) {
    return undefined;
  }
  const confidence =
    'confidence' in answer && typeof (answer as { confidence?: unknown }).confidence === 'number'
      ? (answer as { confidence: number }).confidence
      : 0;
  return { score: (answer as { score: number }).score, confidence };
}

/** Jev scores arrive either in [0, 1] or spread across the criteria levels. */
function normalizedStaleness(score: number): number {
  return score <= 1 ? score : score / (STALENESS_LEVELS.length - 1);
}

export interface DecideOptions {
  keepThreshold: number;
  borderline: number;
}

/**
 * Decides one call from Jev's answers: keep, truncate the result, or drop the
 * call. A result whose keep probability falls just under the threshold is
 * rescued when the staleness score is confidently low. Missing or malformed
 * answers keep the call (conservative).
 */
export function decideCall(
  call: Pick<ToolCall, 'id' | 'tool' | 'pinned'>,
  answers: Record<string, JevAnswer>,
  options: DecideOptions,
): DecisionOutcome {
  if (call.pinned) {
    return {
      id: call.id,
      tool: call.tool,
      keepCall: 1,
      keepResult: 1,
      action: 'keep',
      reason: 'pinned',
      pinned: true,
      guarded: false,
      missing: false,
    };
  }

  const keepCall = noulOr(answers, `call_${call.id}`);
  const keepResult = noulOr(answers, `result_${call.id}`);
  if (keepCall === undefined || keepResult === undefined) {
    return {
      id: call.id,
      tool: call.tool,
      keepCall: keepCall ?? 1,
      keepResult: keepResult ?? 1,
      action: 'keep',
      reason: 'kept',
      pinned: false,
      guarded: false,
      missing: true,
    };
  }

  const base = { id: call.id, tool: call.tool, keepCall, keepResult, pinned: false, missing: false };

  if (keepResult >= options.keepThreshold) {
    return { ...base, action: 'keep', reason: 'kept', guarded: false };
  }

  const staleness = scoreAnswer(answers, `staleness_${call.id}`);
  if (
    keepResult >= options.keepThreshold - options.borderline &&
    staleness !== undefined &&
    normalizedStaleness(staleness.score) <= 0.25 &&
    staleness.confidence >= 0.5
  ) {
    return { ...base, action: 'keep', reason: 'kept', guarded: true };
  }

  if (keepCall >= options.keepThreshold) {
    return { ...base, action: 'drop_result', reason: 'result_dropped', guarded: false };
  }
  return { ...base, action: 'drop_call', reason: 'call_dropped', guarded: false };
}

function truncatedResultText(text: string, isError: boolean, headChars: number): string {
  if (text.length <= headChars + 120) return text;
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : '';
  return `${head}[jev-compaction truncated ${text.length - headChars} chars of this tool result${
    isError ? ' (error)' : ''
  }; re-run the tool if needed]`;
}

/**
 * Rebuilds the conversation from the decisions. A dropped call disappears
 * together with its result; a dropped result keeps a bounded head and a note.
 * Messages that lose all their content are removed; untouched messages are
 * returned as the same objects they came in as.
 */
export function applyJevDecisions(
  messages: readonly Message[],
  decisions: readonly DecisionOutcome[],
  calls: readonly ToolCall[],
  headChars: number,
): Message[] {
  const byId = new Map(calls.map(call => [call.id, call]));
  const actionFor = new Map<string, CallAction>();
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    if (call && decision.action !== 'keep') actionFor.set(call.tool_use_id, decision.action);
  }

  const kept: Message[] = [];
  for (const message of messages) {
    const touched =
      message.toolUses.some(tool => actionFor.has(tool.tool_use_id)) ||
      (message.toolResults ?? []).some(result => actionFor.has(result.tool_use_id));
    if (!touched) {
      kept.push(message);
      continue;
    }

    const toolUses = message.toolUses
      .filter(tool => actionFor.get(tool.tool_use_id) !== 'drop_call')
      .map(tool => {
        if (actionFor.get(tool.tool_use_id) !== 'drop_result' || tool.text === undefined) return tool;
        const text = truncatedResultText(tool.text, tool.isError ?? false, headChars);
        return text === tool.text ? tool : { ...tool, text };
      });
    const toolResults = (message.toolResults ?? [])
      .filter(result => actionFor.get(result.tool_use_id) !== 'drop_call')
      .map(result => {
        if (actionFor.get(result.tool_use_id) !== 'drop_result') return result;
        const text = truncatedResultText(result.text, result.isError ?? false, headChars);
        return text === result.text ? result : { ...result, text };
      });

    const unchanged =
      toolUses.length === message.toolUses.length &&
      toolUses.every((tool, index) => tool === message.toolUses[index]) &&
      toolResults.length === (message.toolResults ?? []).length &&
      toolResults.every((result, index) => result === message.toolResults?.[index]);
    if (unchanged) {
      kept.push(message);
      continue;
    }
    if (message.text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) {
      continue;
    }
    const rebuilt: Message = { role: message.role, text: message.text, toolUses };
    if (toolResults.length > 0) rebuilt.toolResults = toolResults;
    kept.push(rebuilt);
  }
  return kept;
}

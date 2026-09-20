import { convertMessages } from '../../src/compaction/convert.js';
import type { JevCompactionConfig } from '../../src/shared/config.js';
import {
  estimateTokens,
  goalFromMessages,
  type JevAsker,
  type JevQuestions,
  type JevState,
} from '../../src/vendor/fast-jev-compaction/index.js';
import { argText } from './labels.js';
import { redact } from './replay.js';
import type { Prepared } from './run.js';

/**
 * Experiment: tell Jev more than production does. Production sends the span's
 * messages and tool calls but only "ok, N chars (omitted)" for results, and
 * nothing from the tail pi keeps. This wraps the request to add either or both:
 *
 * - `heads`: how each tool output begins, so it can tell what a result is;
 * - `recent`: the newest messages pi keeps verbatim (and the goal drawn from the
 *   newest user prompts), so it can tell what the assistant is doing now.
 *
 * The base history is fitted to a smaller budget by the amount added, so the
 * request stays under the same ceiling as production.
 */
export interface EnrichOptions {
  heads: boolean;
  recent: boolean;
  headChars?: number;
  recentMessages?: number;
  recentTextChars?: number;
}

const NOTE_HEADS = ' Each tool call also shows how its output begins (`output begins`).';
const NOTE_RECENT =
  ' Entries flagged `recent` come after the part being compacted and stay in the history verbatim; ' +
  'they show what the assistant is doing right now and are not among the questions.';

const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();
const truncate = (text: string, limit: number): string => (text.length <= limit ? text : `${text.slice(0, limit - 1)}…`);

interface RecentEntry {
  i: number;
  role: 'user' | 'assistant';
  text: string;
  tool_calls?: string[];
  recent: true;
}

interface LooseState {
  context: string;
  goal: string;
  history: Array<{ tool_calls?: Array<string | { id: string; result: string }> }>;
}

export function enrich(
  item: Prepared,
  base: JevAsker,
  config: JevCompactionConfig,
  options: EnrichOptions,
): { prepared: Prepared; asker: JevAsker; config: JevCompactionConfig; addedTokens: number } {
  // All heads together stay within a fixed budget, so a span with hundreds of calls gets shorter heads
  // instead of squeezing the base history below what it can be truncated to.
  const HEADS_BUDGET_TOKENS = 5_000;
  const headChars = Math.min(
    options.headChars ?? 300,
    Math.max(60, Math.floor((HEADS_BUDGET_TOKENS * 3.5) / Math.max(1, item.calls.length))),
  );
  const results = new Map(item.converted.flatMap(m => (m.toolResults ?? []).map(r => [r.tool_use_id, r.text] as const)));

  const heads = new Map<string, string>();
  if (options.heads) {
    for (const call of item.calls) {
      heads.set(call.id, truncate(redact(flat(results.get(call.tool_use_id) ?? '')), headChars));
    }
  }

  const tail = convertMessages(item.evalCase.tail);
  const recent: RecentEntry[] = [];
  if (options.recent) {
    const usable = tail.filter(m => m.text.trim().length > 0 || m.toolUses.length > 0);
    usable.slice(-(options.recentMessages ?? 6)).forEach((message, index) => {
      recent.push({
        i: item.converted.length + index,
        role: message.role,
        text: redact(truncate(message.text.trim(), options.recentTextChars ?? 700)),
        ...(message.toolUses.length
          ? { tool_calls: message.toolUses.map(t => redact(truncate(flat(`${t.tool} ${argText(t.input)}`), 140))) }
          : {}),
        recent: true,
      });
    });
  }

  const addedTokens =
    [...heads.values()].reduce((sum, head) => sum + estimateTokens(head) + 8, 0) +
    estimateTokens(JSON.stringify(recent)) +
    (options.heads ? 20 : 0) +
    (options.recent ? 60 : 0);

  const goal = options.recent ? goalFromMessages([...item.converted, ...tail]) : undefined;
  const prepared: Prepared = goal
    ? { ...item, input: { ...item.input, customInstructions: goal } }
    : item;

  const asker: JevAsker = {
    ask(state: JevState, questions: JevQuestions) {
      const copy = structuredClone(state) as LooseState;
      if (options.heads) {
        copy.context += NOTE_HEADS;
        for (const entry of copy.history) {
          for (const call of entry.tool_calls ?? []) {
            if (typeof call === 'object' && heads.has(call.id)) {
              call.result = `${call.result}; output begins: ${JSON.stringify(heads.get(call.id))}`;
            }
          }
        }
      }
      if (options.recent) {
        copy.context += NOTE_RECENT;
        copy.history.push(...(recent as unknown as LooseState['history']));
      }
      return base.ask(copy, questions);
    },
  };

  return {
    prepared,
    asker,
    addedTokens,
    config: { ...config, maxStateTokens: Math.max(8_000, config.maxStateTokens - addedTokens) },
  };
}

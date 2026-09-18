import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { JevAnswer, JevAsker, JevQuestions, JevResponse, JevState } from '../src/vendor/fast-jev-compaction/index.js';
import { configFromEnv, type JevCompactionConfig } from '../src/shared/config.js';

export interface AskPlan {
  keepCall?: number;
  keepResult?: number;
  score?: number;
  confidence?: number;
}

/** A fake `JevAsker` answering by call id from a plan; unlisted calls keep everything. */
export function fakeAsker(plan: Record<string, AskPlan> = {}) {
  const asks: Array<{ state: JevState; questions: JevQuestions }> = [];
  const asker: JevAsker = {
    async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
      asks.push({ state, questions });
      const answers: Record<string, JevAnswer> = {};
      for (const name of Object.keys(questions)) {
        if (!name.includes('_')) {
          // Single, named questions (e.g. routing’s `difficulty`)
          const named = plan[name] ?? {};
          answers[name] = {
            type: 'score',
            score: named.score ?? 0,
            confidence: named.confidence ?? 0.8,
            probabilities: {},
          };
          continue;
        }
        const kind = name.slice(0, name.indexOf('_'));
        const id = name.slice(name.indexOf('_') + 1);
        const entry = plan[id] ?? {};
        if (kind === 'call') {
          answers[name] = { type: 'noul', noul: entry.keepCall ?? 0.99 };
        } else if (kind === 'result') {
          answers[name] = { type: 'noul', noul: entry.keepResult ?? 0.99 };
        } else {
          answers[name] = {
            type: 'score',
            score: entry.score ?? 0,
            confidence: entry.confidence ?? 0.8,
            probabilities: {},
          };
        }
      }
      return { model: 'jev-fake', answers, usage: { input_tokens: 12, output_tokens: 3 } };
    },
  };
  return Object.assign(asker, { asks });
}

/** Default config with overrides applied. */
export function withDefaults(overrides: Partial<JevCompactionConfig> = {}): JevCompactionConfig {
  return { ...configFromEnv({}), ...overrides };
}

export function bigText(times: number): string {
  return 'x'.repeat(times);
}

function assistantMessage(
  blocks: Array<
    | { type: 'text'; text: string }
    | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }
  >,
): AgentMessage {
  return {
    role: 'assistant',
    content: blocks,
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude',
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 2,
  };
}

/** A realistic span: user goal, three tool calls with large results, wrap-up turns. */
export function spanMessages(): AgentMessage[] {
  return [
    { role: 'user', content: 'Fix the failing test. Never edit src/generated.', timestamp: 1 },
    assistantMessage([{ type: 'toolCall', id: 'u1', name: 'read', arguments: { path: 'src/a.ts' } }]),
    { role: 'toolResult', toolCallId: 'u1', toolName: 'read', content: [{ type: 'text', text: 'A'.repeat(5000) }], isError: false, timestamp: 3 },
    assistantMessage([{ type: 'toolCall', id: 'u2', name: 'read', arguments: { path: 'src/b.ts' } }]),
    { role: 'toolResult', toolCallId: 'u2', toolName: 'read', content: [{ type: 'text', text: 'B'.repeat(4000) }], isError: false, timestamp: 5 },
    assistantMessage([{ type: 'toolCall', id: 'u3', name: 'grep', arguments: { pattern: 'TODO' } }]),
    { role: 'toolResult', toolCallId: 'u3', toolName: 'grep', content: [{ type: 'text', text: 'obsolete grep result\n' + 'C'.repeat(3000) }], isError: false, timestamp: 7 },
    { role: 'user', content: 'Now summarize what you found.', timestamp: 8 },
    { role: 'user', content: 'Also check the build.', timestamp: 9 },
    assistantMessage([{ type: 'text', text: 'Build passes locally.' }]),
  ];
}

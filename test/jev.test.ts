import { describe, expect, it } from 'vitest';
import type { JevAnswer, Message, ToolCall } from '../src/vendor/fast-jev-compaction/index.js';
import { compactWithJev } from '../src/compaction/jev.js';
import { applyJevDecisions, decideCall, questionsFor } from '../src/compaction/decision.js';
import { bigText, fakeAsker, withDefaults } from './helpers.js';

function message(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string): Message {
  return message('assistant', '', { toolUses: [{ tool_use_id: id, tool, input, text }] });
}

describe('questionsFor', () => {
  it('asks two noul questions and one score question per call', () => {
    const toolCall: ToolCall = {
      id: 't1', tool_use_id: 'u1', tool: 'read', input: {},
      callIndex: 1, resultIndex: 2, resultChars: 100, isError: false, pinned: false,
    };
    const questions = questionsFor(toolCall);
    expect(Object.keys(questions).sort()).toEqual(['call_t1', 'result_t1', 'staleness_t1']);
    expect(questions.call_t1.type).toBe('noul');
    expect(questions.staleness_t1.type).toBe('score');
  });
});

describe('decideCall', () => {
  const config = { keepThreshold: 0.5, borderline: 0.1 };
  const base: ToolCall = {
    id: 't1', tool_use_id: 'u1', tool: 'read', input: {},
    callIndex: 1, resultIndex: 2, resultChars: 100, isError: false, pinned: false,
  };

  function answers(keepCall: number, keepResult: number, score?: number, confidence?: number): Record<string, JevAnswer> {
    const out: Record<string, JevAnswer> = {
      call_t1: { type: 'noul', noul: keepCall },
      result_t1: { type: 'noul', noul: keepResult },
    };
    if (score !== undefined) out.staleness_t1 = { type: 'score', score, confidence: confidence ?? 0.8, probabilities: {} };
    return out;
  }

  it('keeps when keepResult is at or above the threshold', () => {
    expect(decideCall(base, answers(0.9, 0.6), config).action).toBe('keep');
  });

  it('keeps a borderline result when staleness score is confidently low', () => {
    const outcome = decideCall(base, answers(0.9, 0.45, 0.2, 0.7), config);
    expect(outcome.action).toBe('keep');
    expect(outcome.guarded).toBe(true);
  });

  it('does not guard when the score is stale-scaled', () => {
    const outcome = decideCall(base, answers(0.9, 0.45, 2), config); // 2 of 4 levels = 0.5
    expect(outcome.action).toBe('drop_result');
    expect(outcome.guarded).toBe(false);
  });

  it('does not guard when confidence is low', () => {
    const outcome = decideCall(base, answers(0.9, 0.45, 0.1, 0.3), config);
    expect(outcome.action).toBe('drop_result');
  });

  it('drops the result when only the call matters', () => {
    expect(decideCall(base, answers(0.9, 0.2), config).action).toBe('drop_result');
  });

  it('drops the whole call when neither matters', () => {
    expect(decideCall(base, answers(0.2, 0.1), config).action).toBe('drop_call');
  });

  it('keeps conservatively when answers are missing', () => {
    const outcome = decideCall(base, {}, config);
    expect(outcome.action).toBe('keep');
    expect(outcome.missing).toBe(true);
  });

  it('never drops pinned calls', () => {
    const outcome = decideCall({ ...base, pinned: true }, answers(0, 0), config);
    expect(outcome.action).toBe('keep');
    expect(outcome.pinned).toBe(true);
  });
});

describe('applyJevDecisions', () => {
  it('truncates dropped results with a jev-compaction note and removes dropped calls', () => {
    const messages: Message[] = [
      message('user', 'task'),
      call('u1', 'read', { path: 'a' }, bigText(1000)),
      message('user', '', { toolResults: [{ tool_use_id: 'u1', text: bigText(1000) }] }),
      call('u2', 'grep', { pattern: 'x' }, ''),
      message('user', '', { toolResults: [{ tool_use_id: 'u2', text: bigText(800) }] }),
      message('user', 'next'),
    ];
    const calls = [
      { id: 't1', tool_use_id: 'u1', tool: 'read', input: {}, callIndex: 1, resultIndex: 2, resultChars: 1000, isError: false, pinned: false },
      { id: 't2', tool_use_id: 'u2', tool: 'grep', input: {}, callIndex: 3, resultIndex: 4, resultChars: 800, isError: false, pinned: false },
    ] as ToolCall[];
    const decisions = [
      { id: 't1', tool: 'read', keepCall: 0.9, keepResult: 0.1, action: 'drop_result' as const, reason: 'result_dropped' as const, pinned: false, guarded: false, missing: false },
      { id: 't2', tool: 'grep', keepCall: 0.1, keepResult: 0.1, action: 'drop_call' as const, reason: 'call_dropped' as const, pinned: false, guarded: false, missing: false },
    ];
    const kept = applyJevDecisions(messages, decisions, calls, 300);
    const resultText = kept[2].toolResults?.[0]?.text ?? '';
    expect(resultText).toContain('[jev-compaction truncated 700 chars');
    expect(kept.some(m => m.toolUses.some(t => t.tool_use_id === 'u2'))).toBe(false);
    expect(kept.some(m => (m.toolResults ?? []).some(r => r.tool_use_id === 'u2'))).toBe(false);
    // empty result-only message for u2 is removed
    expect(kept.filter(m => (m.toolResults ?? []).length === 0 && m.text === '' && m.toolUses.length === 0)).toHaveLength(0);
  });
});

describe('compactWithJev', () => {
  it('scores every candidate, merges batches and reports stats', async () => {
    const messages: Message[] = [
      message('user', 'Fix the bug in src/a.ts. Never edit src/generated.'),
      call('u1', 'read', { path: 'src/a.ts' }, ''),
      message('user', '', { toolResults: [{ tool_use_id: 'u1', text: bigText(5000) }] }),
      call('u2', 'read', { path: 'src/b.ts' }, ''),
      message('user', '', { toolResults: [{ tool_use_id: 'u2', text: bigText(4000) }] }),
      call('u3', 'grep', { pattern: 'TODO' }, ''),
      message('user', '', { toolResults: [{ tool_use_id: 'u3', text: bigText(3000) }] }),
      message('user', 'Now summarize what you found.'),
    ];
    const plan: Record<string, { keepCall: number; keepResult: number; score?: number }> = {
      t1: { keepCall: 0.9, keepResult: 0.9 },
      t2: { keepCall: 0.9, keepResult: 0.2 },
      t3: { keepCall: 0.1, keepResult: 0.1 },
    };
    const asker = fakeAsker(plan);
    const outcome = await compactWithJev(messages, asker, withDefaults({ preserveRecentMessages: 0 }), 'fix the bug');

    expect(outcome.stats.calls).toBe(3);
    expect(outcome.stats.kept).toBe(1);
    expect(outcome.stats.resultsDropped).toBe(1);
    expect(outcome.stats.callsDropped).toBe(1);
    expect(outcome.stats.requests).toBeGreaterThanOrEqual(1);
    expect(outcome.stats.charsAfter).toBeLessThan(outcome.stats.charsBefore);
    expect(outcome.stats.jevUsage).toEqual({ input: 12, output: 3 });
    // the state carries the goal
    const state = asker.asks[0].state as { goal: string; history: unknown[] };
    expect(state.goal).toBe('fix the bug');
  });

  it('splits batches when questions do not fit the request budget', async () => {
    const messages: Message[] = [
      message('user', 'goal'),
      ...Array.from({ length: 5 }, (_, i) => [
        call(`u${i}`, 'read', { path: `f${i}` }, ''),
        message('user', '', { toolResults: [{ tool_use_id: `u${i}`, text: bigText(2000) }] }),
      ]).flat(),
      message('user', 'done'),
    ];
    const asker = fakeAsker({});
    await compactWithJev(messages, asker, withDefaults({ maxRequestTokens: 950, maxStateTokens: 3000 }));
    expect(asker.asks.length).toBeGreaterThan(1);
    for (const { questions } of asker.asks) {
      expect(Object.keys(questions).length % 3).toBe(0); // whole calls per batch
    }
  });
});

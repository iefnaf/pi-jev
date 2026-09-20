import { describe, expect, it } from 'vitest';
import type { JevAnswer, Message, ToolCall } from '../src/vendor/fast-jev-compaction/index.js';
import { compactWithJev } from '../src/compaction/jev.js';
import { applyJevDecisions, boundaryCallId, decideCall, questionsFor } from '../src/compaction/decision.js';
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

  it('bounds the boundary call instead of dropping it', () => {
    const outcome = decideCall(base, answers(0.2, 0.1), { ...config, boundary: true });
    expect(outcome.action).toBe('drop_result');
    expect(outcome.reason).toBe('boundary');
    expect(outcome.boundary).toBe(true);
  });

  it('still drops a call that is not at the cut boundary', () => {
    const outcome = decideCall(base, answers(0.2, 0.1), config);
    expect(outcome.action).toBe('drop_call');
    expect(outcome.boundary).toBe(false);
  });

  it('keeps a boundary result Jev explicitly wants verbatim', () => {
    const outcome = decideCall(base, answers(0.9, 0.9), { ...config, boundary: true });
    expect(outcome.action).toBe('keep');
    expect(outcome.boundary).toBe(true);
  });
});

describe('boundaryCallId', () => {
  function span(): Message[] {
    return [
      message('user', 'task'),
      call('u1', 'read', { path: 'a' }, ''),
      message('user', '', { toolResults: [{ tool_use_id: 'u1', text: 'r' }] }),
    ];
  }
  function calls(): ToolCall[] {
    return [{
      id: 't1', tool_use_id: 'u1', tool: 'read', input: {},
      callIndex: 1, resultIndex: 2, resultChars: 1, isError: false, pinned: false,
    }];
  }

  it('returns the call whose result is the final message', () => {
    expect(boundaryCallId(span(), calls())).toBe('t1');
  });

  it('returns undefined when the span ends with text', () => {
    expect(boundaryCallId([...span(), message('user', 'next')], calls())).toBeUndefined();
  });

  it('returns undefined when the final result belongs to no scored call', () => {
    const messages: Message[] = [
      message('user', 'task'),
      message('user', '', { toolResults: [{ tool_use_id: 'u9', text: 'r' }] }),
    ];
    expect(boundaryCallId(messages, [])).toBeUndefined();
  });

  it('picks the newest call when parallel results share the final message', () => {
    const messages: Message[] = [
      message('user', 'task'),
      message('assistant', '', {
        toolUses: [
          { tool_use_id: 'u1', tool: 'read', input: {} },
          { tool_use_id: 'u2', tool: 'read', input: {} },
        ],
      }),
      message('user', '', {
        toolResults: [
          { tool_use_id: 'u1', text: 'a' },
          { tool_use_id: 'u2', text: 'b' },
        ],
      }),
    ];
    const parallel: ToolCall[] = [
      { id: 't1', tool_use_id: 'u1', tool: 'read', input: {}, callIndex: 1, resultIndex: 2, resultChars: 1, isError: false, pinned: false },
      { id: 't2', tool_use_id: 'u2', tool: 'read', input: {}, callIndex: 1, resultIndex: 2, resultChars: 1, isError: false, pinned: false },
    ];
    expect(boundaryCallId(messages, parallel)).toBe('t2');
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
      { id: 't1', tool: 'read', keepCall: 0.9, keepResult: 0.1, action: 'drop_result' as const, reason: 'result_dropped' as const, boundary: false, guarded: false, missing: false },
      { id: 't2', tool: 'grep', keepCall: 0.1, keepResult: 0.1, action: 'drop_call' as const, reason: 'call_dropped' as const, boundary: false, guarded: false, missing: false },
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
    const outcome = await compactWithJev(messages, asker, withDefaults(), 'fix the bug');

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

  it('bounds a huge result at the cut boundary instead of dropping it', async () => {
    const messages: Message[] = [
      message('user', 'Fix the bug'),
      call('u1', 'read', { path: 'src/a.ts' }, ''),
      message('user', '', { toolResults: [{ tool_use_id: 'u1', text: bigText(6000) }] }),
      call('u2', 'web_search', { query: 'chrome api' }, ''),
      message('user', '', { toolResults: [{ tool_use_id: 'u2', text: bigText(50_000) }] }),
    ];
    const asker = fakeAsker({
      t1: { keepCall: 0.9, keepResult: 0.1 },
      t2: { keepCall: 0.05, keepResult: 0.05 }, // Jev would drop it entirely
    });
    const outcome = await compactWithJev(messages, asker, withDefaults(), 'fix the bug');

    expect(outcome.stats.boundary).toBe(1);
    expect(outcome.stats.callsDropped).toBe(0);
    expect(outcome.stats.charsAfter).toBeLessThan(2000);
    const transcript = outcome.messages
      .map(m => [m.text, ...m.toolUses.map(t => t.tool), ...(m.toolResults ?? []).map(r => r.text)].join('\n'))
      .join('\n');
    expect(transcript).toContain('web_search'); // call metadata survives
    expect(transcript).toContain('[jev-compaction truncated');
    expect(transcript).not.toContain('x'.repeat(5000));
  });

  it('keeps user and assistant text verbatim when calls are dropped', async () => {
    const messages: Message[] = [
      message('user', 'Keep this instruction verbatim.'),
      call('u1', 'read', { path: 'a' }, ''),
      message('user', '', { toolResults: [{ tool_use_id: 'u1', text: bigText(1000) }] }),
      message('assistant', 'And this answer.'),
    ];
    const outcome = await compactWithJev(
      messages,
      fakeAsker({ t1: { keepCall: 0.05, keepResult: 0.05 } }),
      withDefaults(),
      'goal',
    );
    expect(outcome.messages.map(m => m.text)).toContain('Keep this instruction verbatim.');
    expect(outcome.messages.map(m => m.text)).toContain('And this answer.');
  });

  it('keeps calls conservatively when Jev omits answers', async () => {
    const messages: Message[] = [
      message('user', 'goal'),
      call('u1', 'read', { path: 'a' }, ''),
      message('user', '', { toolResults: [{ tool_use_id: 'u1', text: bigText(1000) }] }),
      message('user', 'done'),
    ];
    const asker = { ask: async () => ({ answers: {} }) };
    const outcome = await compactWithJev(messages, asker, withDefaults(), 'goal');
    expect(outcome.stats.missing).toBe(1);
    expect(outcome.stats.callsDropped).toBe(0);
    expect(outcome.stats.resultsDropped).toBe(0);
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

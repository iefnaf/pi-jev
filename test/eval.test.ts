import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { distinctiveTokens, labelCase } from '../eval/lib/labels.js';
import { runBaseline } from '../eval/lib/policies.js';
import { auc, matchedAuc } from '../eval/lib/score.js';
import { collectToolCalls, type Message } from '../src/vendor/fast-jev-compaction/index.js';

const call = (id: string, tool: string, input: Record<string, unknown>): Message => ({
  role: 'assistant',
  text: '',
  toolUses: [{ tool_use_id: id, tool, input }],
});
const result = (id: string, text: string): Message => ({
  role: 'user',
  text: '',
  toolUses: [],
  toolResults: [{ tool_use_id: id, text }],
});
const assistant = (...blocks: Array<Record<string, unknown>>): AgentMessage =>
  ({ role: 'assistant', content: blocks }) as unknown as AgentMessage;
const toolCall = (name: string, args: Record<string, unknown>) => ({ type: 'toolCall', id: 'x', name, arguments: args });
const text = (value: string) => ({ type: 'text', text: value });
const observed = (value: string): AgentMessage =>
  ({ role: 'toolResult', toolCallId: 'x', toolName: 'read', content: [{ type: 'text', text: value }], isError: false }) as unknown as AgentMessage;

function label(span: Message[], future: AgentMessage[], tail: AgentMessage[] = []) {
  return labelCase(span, collectToolCalls(span, 0), tail, future);
}

describe('distinctiveTokens', () => {
  it('keeps paths and code identifiers, drops plain words and bare numbers', () => {
    const tokens = distinctiveTokens('see packages/core/src/index.ts and buildJevRequest, then the configuration took 12345 ms');
    expect(tokens).toContain('packages/core/src/index.ts');
    expect(tokens).toContain('buildJevRequest');
    expect(tokens).not.toContain('configuration');
    expect(tokens).not.toContain('12345');
  });
});

describe('labelCase', () => {
  const span = [call('a', 'read', { path: 'src/a.ts' }), result('a', 'export function computeAlpha() {}\nexport const betaValue = 1')];

  it('marks a repeated read as rerun but not as used', () => {
    const labels = label(span, [assistant(toolCall('read', { path: 'src/a.ts' }))]);
    expect(labels.calls.get('t1')).toMatchObject({ rerun: true, used: false });
  });

  it('does not attribute strings shared by two span results to either', () => {
    const twice = [...span, call('b', 'bash', { command: 'cat src/a.ts' }), result('b', 'export function computeAlpha() {}\nexport const betaValue = 1')];
    const labels = label(twice, [assistant(text('I will change computeAlpha and betaValue'))]);
    expect(labels.calls.get('t1')).toMatchObject({ echo: 2, echoUnique: 0, used: false });
    expect(labels.calls.get('t2')).toMatchObject({ used: false });
    expect(labels.needed).toEqual(new Set(['computeAlpha', 'betaValue']));
  });

  it('does not count a re-read after an edit of that file', () => {
    const labels = label(span, [
      assistant(toolCall('edit', { path: 'src/a.ts' })),
      assistant(toolCall('read', { path: 'src/a.ts' })),
    ]);
    expect(labels.calls.get('t1')?.rerun).toBe(false);
  });

  it('marks an earlier read superseded by a later identical one in the span', () => {
    const twice = [...span, call('b', 'read', { path: 'src/a.ts' }), result('b', 'export function computeAlpha() {}')];
    const labels = label(twice, []);
    expect(labels.calls.get('t1')?.superseded).toBe(true);
    expect(labels.calls.get('t2')?.superseded).toBe(false);
  });

  it('credits identifiers the agent produced before anything showed them', () => {
    const labels = label(span, [assistant(text('I will change computeAlpha and betaValue'))]);
    expect(labels.calls.get('t1')).toMatchObject({ echo: 2, used: true });
    expect(labels.needed).toEqual(new Set(['computeAlpha', 'betaValue']));
  });

  it('ignores identifiers copied from newer observations', () => {
    const labels = label(span, [observed('computeAlpha betaValue'), assistant(text('changing computeAlpha and betaValue'))]);
    expect(labels.calls.get('t1')).toMatchObject({ echo: 0, used: false });
  });

  it('ignores identifiers already present in the kept tail', () => {
    const labels = label(span, [assistant(text('computeAlpha betaValue'))], [assistant(text('computeAlpha betaValue'))]);
    expect(labels.calls.get('t1')?.used).toBe(false);
  });
});

describe('auc', () => {
  it('is 1 for a perfect order, 0.5 for ties, null without both classes', () => {
    expect(auc([3, 2, 1], [true, false, false])).toBe(1);
    expect(auc([1, 1], [true, false])).toBe(0.5);
    expect(auc([1, 2], [true, true])).toBeNull();
  });

  it('matchedAuc only compares same-tool calls of similar size', () => {
    // The positive outranks the negative that is far larger, but that pair is skipped.
    const value = matchedAuc([2, 1, 3], [true, false, false], ['read', 'read', 'read'], [100, 110, 100_000]);
    expect(value).toBe(1);
    expect(matchedAuc([2, 1], [true, false], ['read', 'bash'], [100, 100])).toBeNull();
  });
});

describe('runBaseline', () => {
  const messages: Message[] = [];
  for (let i = 0; i < 8; i++) {
    messages.push(call(`c${i}`, 'read', { path: `f${i}.ts` }), result(`c${i}`, `line ${i}\n`.repeat(400)));
  }
  const calls = collectToolCalls(messages, 0);

  it('stays within the budget and keeps more verbatim results when the budget grows', () => {
    const small = runBaseline('recent', messages, calls, 'goal', 300, 1_500, 's');
    const large = runBaseline('recent', messages, calls, 'goal', 300, 6_000, 's');
    expect(small.summaryTokens).toBeLessThanOrEqual(1_500);
    expect(large.summaryTokens).toBeLessThanOrEqual(6_000);
    const keptCount = (outcome: typeof small) => [...outcome.actions.values()].filter(action => action === 'keep').length;
    expect(keptCount(large)).toBeGreaterThan(keptCount(small));
  });

  it('recent keeps the newest results first', () => {
    const outcome = runBaseline('recent', messages, calls, 'goal', 300, 3_000, 's');
    const kept = calls.filter(c => outcome.actions.get(c.id) === 'keep').map(c => c.resultIndex);
    expect(kept.length).toBeGreaterThan(0);
    expect(Math.min(...kept)).toBeGreaterThan(Math.max(...calls.filter(c => outcome.actions.get(c.id) !== 'keep').map(c => c.resultIndex)) - 1);
  });
});

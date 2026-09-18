import { describe, expect, it } from 'vitest';
import type { Message } from '../src/vendor/fast-jev-compaction/index.js';
import { renderSummary, renderTranscript } from '../src/compaction/summarize.js';

const messages: Message[] = [
  { role: 'user', text: 'Fix the test', toolUses: [], toolResults: [] },
  {
    role: 'assistant',
    text: 'Reading first.',
    toolUses: [{ tool_use_id: 'u1', tool: 'read', input: { path: 'src/a.ts' } }],
  },
  {
    role: 'user',
    text: '',
    toolUses: [],
    toolResults: [{ tool_use_id: 'u1', text: 'file contents here' }],
  },
  {
    role: 'assistant',
    text: '',
    toolUses: [
      {
        tool_use_id: 'u2',
        tool: 'edit',
        input: { path: 'src/a.ts', old: 'a'.repeat(400), new: 'b' },
      },
    ],
  },
  {
    role: 'user',
    text: '',
    toolUses: [],
    toolResults: [{ tool_use_id: 'u2', text: 'ok' }],
  },
];

describe('renderTranscript', () => {
  it('renders roles, calls and results flat', () => {
    const text = renderTranscript(messages);
    expect(text).toContain('[User]: Fix the test');
    expect(text).toContain('[Assistant]: Reading first.');
    expect(text).toContain('[Assistant tool calls]: read(path=src/a.ts)');
    expect(text).toContain('[Assistant tool calls]: edit(path=src/a.ts');
    expect(text).toContain('[Tool result]: file contents here');
  });

  it('caps long argument values', () => {
    const text = renderTranscript(messages);
    const old = /old=(\S+)/.exec(text)?.[1] ?? '';
    expect(old.length).toBeLessThanOrEqual(160);
    expect(old.endsWith('…')).toBe(true);
  });
});

describe('renderSummary', () => {
  it('wraps the transcript with an explanatory header and goal', () => {
    const summary = renderSummary(messages, { goal: 'fix the test', droppedCalls: 2, truncatedResults: 1 });
    expect(summary).toContain('<compacted-conversation>');
    expect(summary).toContain('2 obsolete tool calls were removed');
    expect(summary).toContain('Ongoing goal: fix the test');
    expect(summary).toContain('[User]: Fix the test');
  });

  it('prepends the previous summary when present', () => {
    const summary = renderSummary(messages, { previousSummary: 'old summary text' });
    expect(summary.indexOf('old summary text')).toBeLessThan(summary.indexOf('<compacted-conversation>'));
  });
});

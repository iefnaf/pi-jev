import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { convertMessages } from '../src/compaction/convert.js';

function user(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: 1 };
}

function assistant(
  blocks: Array<{ type: 'text'; text: string } | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }>,
): AgentMessage {
  return {
    role: 'assistant',
    content: blocks,
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: 2,
  };
}

function toolResult(toolCallId: string, text: string, isError = false): AgentMessage {
  return { role: 'toolResult', toolCallId, toolName: 'read', content: [{ type: 'text', text }], isError, timestamp: 3 };
}

function bashExecution(command: string, output: string, extra: Partial<Extract<AgentMessage, { role: 'bashExecution' }>> = {}): AgentMessage {
  return {
    role: 'bashExecution',
    command,
    output,
    exitCode: 0,
    cancelled: false,
    truncated: false,
    timestamp: 4,
    ...extra,
  };
}

describe('convertMessages', () => {
  it('converts user and assistant text and tool calls', () => {
    const messages = convertMessages([
      user('Fix the test'),
      assistant([
        { type: 'text', text: 'Reading the file first.' },
        { type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: 'src/a.ts' } },
      ]),
    ]);
    expect(messages).toEqual([
      { role: 'user', text: 'Fix the test', toolUses: [], toolResults: [] },
      {
        role: 'assistant',
        text: 'Reading the file first.',
        toolUses: [{ tool_use_id: 'call_1', tool: 'read', input: { path: 'src/a.ts' } }],
      },
    ]);
  });

  it('merges consecutive tool results into one user message', () => {
    const messages = convertMessages([
      user('go'),
      assistant([{ type: 'toolCall', id: 'a', name: 'read', arguments: {} }, { type: 'toolCall', id: 'b', name: 'grep', arguments: {} }]),
      toolResult('a', 'first'),
      toolResult('b', 'second'),
      user('next'),
    ]);
    expect(messages).toHaveLength(4);
    expect(messages[2]).toEqual({
      role: 'user',
      text: '',
      toolUses: [],
      toolResults: [
        { tool_use_id: 'a', text: 'first', isError: false },
        { tool_use_id: 'b', text: 'second', isError: false },
      ],
    });
  });

  it('synthesizes a bash call pair for bashExecution messages', () => {
    const messages = convertMessages([bashExecution('npm test', 'all pass')]);
    expect(messages).toEqual([
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'bashexec_4', tool: 'bash', input: { command: 'npm test' } }] },
      {
        role: 'user',
        text: '',
        toolUses: [],
        toolResults: [{ tool_use_id: 'bashexec_4', text: 'all pass', isError: false }],
      },
    ]);
  });

  it('skips excluded bash executions and flags failures as errors', () => {
    const messages = convertMessages([
      bashExecution('!!secret', 'nope', { excludeFromContext: true }),
      bashExecution('npm build', 'failed', { exitCode: 1 }),
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[1].toolResults?.[0]?.isError).toBe(true);
  });

  it('keeps custom messages as user text and drops thinking', () => {
    const messages = convertMessages([
      assistant([
        { type: 'text', text: 'visible' },
      ]),
    ]);
    expect(messages[0].text).toBe('visible');
  });

  it('notes images in user content blocks', () => {
    const messages = convertMessages([
      { role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image', data: 'x', mimeType: 'image/png' }], timestamp: 1 },
    ]);
    expect(messages[0].text).toBe('see\n[image]');
  });
});

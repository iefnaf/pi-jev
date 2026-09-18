import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Message, ToolResult } from '../vendor/fast-jev-compaction/index.js';

type Blocks = Array<{ type: string; text?: string }>;

/** Extracts text from a string-or-content-blocks payload; images become a note. */
function textOf(content: string | Blocks): string {
  if (typeof content === 'string') return content;
  return content
    .map(block => (block.type === 'text' && typeof block.text === 'string' ? block.text : '[image]'))
    .join('\n');
}

/**
 * Converts the span pi wants to summarize (any `AgentMessage`) into the
 * Claude-Code-shaped `Message[]` fast-jev-compaction works with:
 *
 * - `toolResult` messages merge into synthetic user messages (consecutive
 *   ones share one message), keeping their call order;
 * - `bashExecution` messages become an assistant tool call (`bash`) paired
 *   with a user tool result, so Jev can drop their outputs like any other;
 * - assistant thinking is dropped (transient, never needed verbatim later);
 * - `compactionSummary` / `branchSummary` are skipped: the hook receives the
 *   previous summary separately (`previousSummary`);
 * - images cannot be represented and render as `[image]`.
 */
export function convertMessages(messages: readonly AgentMessage[]): Message[] {
  const out: Message[] = [];
  let pendingResults: ToolResult[] = [];

  const flushResults = (): void => {
    if (pendingResults.length > 0) {
      out.push({ role: 'user', text: '', toolUses: [], toolResults: pendingResults });
      pendingResults = [];
    }
  };

  for (const message of messages) {
    switch (message.role) {
      case 'user': {
        flushResults();
        out.push({ role: 'user', text: textOf(message.content), toolUses: [], toolResults: [] });
        break;
      }
      case 'assistant': {
        flushResults();
        const text = message.content
          .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
          .map(block => block.text)
          .join('\n');
        const toolUses = message.content
          .filter((block): block is { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> } =>
            block.type === 'toolCall',
          )
          .map(block => ({ tool_use_id: block.id, tool: block.name, input: block.arguments }));
        out.push({ role: 'assistant', text, toolUses });
        break;
      }
      case 'toolResult': {
        pendingResults.push({
          tool_use_id: message.toolCallId,
          text: textOf(message.content),
          isError: message.isError,
        });
        break;
      }
      case 'bashExecution': {
        flushResults();
        if (message.excludeFromContext) break;
        const id = `bashexec_${message.timestamp}`;
        out.push({
          role: 'assistant',
          text: '',
          toolUses: [{ tool_use_id: id, tool: 'bash', input: { command: message.command } }],
        });
        pendingResults.push({
          tool_use_id: id,
          text: message.output,
          isError: message.cancelled || (message.exitCode !== undefined && message.exitCode !== 0),
        });
        break;
      }
      case 'custom': {
        flushResults();
        out.push({ role: 'user', text: textOf(message.content), toolUses: [], toolResults: [] });
        break;
      }
      default:
        // compactionSummary / branchSummary arrive via previousSummary instead
        break;
    }
  }
  flushResults();
  return out;
}

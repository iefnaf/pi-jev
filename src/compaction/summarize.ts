import type { Message } from '../vendor/fast-jev-compaction/index.js';

const ARG_VALUE_LIMIT = 160;

function argValue(value: unknown): string {
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = '[unserializable]';
    }
  }
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= ARG_VALUE_LIMIT ? flat : `${flat.slice(0, ARG_VALUE_LIMIT - 1)}…`;
}

function renderCall(name: string, input: Record<string, unknown>): string {
  const args = Object.entries(input)
    .map(([key, value]) => `${key}=${argValue(value)}`)
    .join(' ');
  return args.length > 0 ? `${name}(${args})` : name;
}

/**
 * Renders messages as a flat transcript in the same style pi uses for
 * summarization, so the LLM reads a familiar format. Applied to both the
 * original and the compacted span, it doubles as the size estimator.
 */
export function renderTranscript(messages: readonly Message[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    const trimmed = message.text.trim();
    if (trimmed.length > 0) {
      lines.push(`[${message.role === 'user' ? 'User' : 'Assistant'}]: ${trimmed}`);
    }
    if (message.toolUses.length > 0) {
      lines.push(`[Assistant tool calls]: ${message.toolUses.map(call => renderCall(call.tool, call.input)).join('; ')}`);
    }
    for (const result of message.toolResults ?? []) {
      lines.push(`[Tool result]: ${result.text.trim()}`);
    }
  }
  return lines.join('\n\n');
}

export interface SummaryOptions {
  goal?: string;
  previousSummary?: string;
  droppedCalls?: number;
  truncatedResults?: number;
}

/**
 * Builds the compaction summary: the previous summary (kept verbatim, it is
 * already compact) followed by the Jev-retained transcript wrapped in a note
 * explaining what the truncation markers mean.
 */
export function renderSummary(messages: readonly Message[], options: SummaryOptions = {}): string {
  const parts: string[] = [];

  const previous = options.previousSummary?.trim();
  if (previous) {
    parts.push(`<summary-of-earlier-context>\n${previous}\n</summary-of-earlier-context>`);
  }

  const header = [
    'Earlier conversation retained by Jev selective compaction.',
    'User and assistant text is verbatim.',
  ];
  if ((options.droppedCalls ?? 0) > 0) header.push(`${options.droppedCalls} obsolete tool calls were removed.`);
  if ((options.truncatedResults ?? 0) > 0) {
    header.push(`${options.truncatedResults} tool results were truncated (marked); re-run a tool if its full output is needed again.`);
  }
  if (options.goal?.trim()) header.push(`Ongoing goal: ${options.goal.trim()}`);

  parts.push(`<compacted-conversation>\n${header.join(' ')}\n\n${renderTranscript(messages)}\n</compacted-conversation>`);
  return parts.join('\n\n');
}

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { argText, fullText } from './labels.js';

export const REPLAY_CACHE = join(import.meta.dirname, '..', '.cache', 'replay');

/** pi's own wrapper for a compaction summary, so the model sees what it would in production. */
const SUMMARY_PREFIX = 'The conversation history before this point was compacted into the following summary:\n\n<summary>\n';
const SUMMARY_SUFFIX = '\n</summary>';

const SYSTEM_PROMPT =
  'You are a coding agent working in the user\'s repository through tools. Continue the conversation: ' +
  'respond with your next step, either a tool call or a message to the user.';

// --------------------------------------------------------------------- redaction

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:sk|ark|pk|ghp|gho|glpat|xox[bap])[-_][A-Za-z0-9_-]{16,}/g, '[redacted-key]'],
  [/\b[0-9a-f]{32}\.[A-Za-z0-9]{12,}\b/g, '[redacted-key]'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[redacted-jwt]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g, 'Bearer [redacted]'],
  [/((?:api[_-]?key|token|secret|passw(?:or)?d|authorization|密钥|令牌)["']?\s*[:：=]\s*["']?)[A-Za-z0-9_\-./+=]{12,}/gi, '$1[redacted]'],
  [/(token|key|密钥)\s*[:：]\s*[0-9A-Za-z]{16,}/gi, '$1: [redacted]'],
  [/(:\/\/[^:/\s@]+:)[^@\s/]+@/g, '$1[redacted]@'],
];

/** Best-effort removal of credentials before content leaves the machine. */
export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text);
}

// ----------------------------------------------------------------- chat format

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools: Array<{ type: 'function'; function: { name: string; description: string; parameters: object } }>;
  /** Sanitised tool name back to the original. */
  names: Map<string, string>;
}

const sanitize = (name: string): string => name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'tool';

type Block = { type: string; [key: string]: unknown };

function blocksOf(message: AgentMessage): Block[] {
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? (content as Block[]) : [];
}

function textOf(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  return blocksOf(message)
    .map(block => (block.type === 'text' ? String(block.text ?? '') : '[image]'))
    .join('\n');
}

/**
 * Converts pi messages to chat-completions messages. `summary`, when given,
 * becomes the first user message exactly as pi presents a compaction summary.
 */
export function toChat(messages: readonly AgentMessage[], summary?: string): ChatRequest {
  const out: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];
  if (summary) out.push({ role: 'user', content: redact(SUMMARY_PREFIX + summary + SUMMARY_SUFFIX) });

  const ids = new Map<string, string>();
  const names = new Map<string, string>();
  const toolNames = new Set<string>();

  for (const message of messages) {
    switch (message.role) {
      case 'user':
      case 'custom':
        out.push({ role: 'user', content: redact(textOf(message)) || '(empty)' });
        break;
      case 'assistant': {
        const text = blocksOf(message)
          .filter(block => block.type === 'text')
          .map(block => String(block.text ?? ''))
          .join('\n');
        const calls: ChatToolCall[] = blocksOf(message)
          .filter(block => block.type === 'toolCall')
          .map(block => {
            const id = `call_${ids.size + 1}`;
            ids.set(String(block.id), id);
            const name = sanitize(String(block.name));
            names.set(name, String(block.name));
            toolNames.add(name);
            return { id, type: 'function' as const, function: { name, arguments: redact(JSON.stringify(block.arguments ?? {})) } };
          });
        if (!text && calls.length === 0) break;
        out.push({ role: 'assistant', content: text ? redact(text) : null, ...(calls.length ? { tool_calls: calls } : {}) });
        break;
      }
      case 'toolResult': {
        const id = ids.get(message.toolCallId);
        const content = redact(textOf(message)) || '(no output)';
        out.push(id ? { role: 'tool', tool_call_id: id, content } : { role: 'user', content: `[earlier tool result]\n${content}` });
        break;
      }
      case 'bashExecution':
        if (!message.excludeFromContext) {
          out.push({ role: 'user', content: redact(`Ran \`${message.command}\`\n\`\`\`\n${message.output}\n\`\`\``) });
        }
        break;
      default:
        break;
    }
  }

  return {
    messages: out,
    names,
    tools: [...toolNames].map(name => ({
      type: 'function' as const,
      function: { name, description: `Tool ${names.get(name) ?? name}`, parameters: { type: 'object', additionalProperties: true } },
    })),
  };
}

export const estimateChatTokens = (request: ChatRequest): number =>
  Math.ceil(request.messages.reduce((sum, m) => sum + (m.content?.length ?? 0) + JSON.stringify(m.tool_calls ?? '').length, 0) / 3.6);

// ---------------------------------------------------------------------- client

export interface ReplayResponse {
  text: string;
  toolCalls: Array<{ name: string; args: string }>;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  finishReason: string;
  cached: boolean;
}

export class BudgetExceeded extends Error {}

export interface ReplayOptions {
  apiKey: string;
  model: string;
  /** Dollars per million prompt tokens, used to refuse a call that would break the budget. */
  promptPrice: number;
  budgetUsd: number;
  offline?: boolean;
  concurrency?: number;
}

export class ReplayClient {
  spent = 0;
  live = 0;
  hits = 0;
  private inFlight = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly options: ReplayOptions) {}

  private async slot(): Promise<() => void> {
    if (this.inFlight >= (this.options.concurrency ?? 3)) await new Promise<void>(resolve => this.waiting.push(resolve));
    this.inFlight += 1;
    return () => {
      this.inFlight -= 1;
      this.waiting.shift()?.();
    };
  }

  async complete(request: ChatRequest): Promise<ReplayResponse> {
    const body = {
      model: this.options.model,
      messages: request.messages,
      tools: request.tools.length ? request.tools : undefined,
      tool_choice: request.tools.length ? 'auto' : undefined,
      temperature: 0,
      // Generous: a reasoning model can spend a small cap entirely on thinking and emit nothing.
      max_tokens: 4000,
      usage: { include: true },
      // Only providers that neither log nor train on prompts; the content is real session data.
      provider: { data_collection: 'deny', require_parameters: true },
    };
    const key = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const path = join(REPLAY_CACHE, key.slice(0, 2), `${key}.json`);
    try {
      const cached = JSON.parse(readFileSync(path, 'utf8')) as ReplayResponse;
      this.hits += 1;
      return { ...cached, cached: true };
    } catch {
      // miss
    }
    if (this.options.offline) throw new Error('replay cache miss while offline');

    const estimate = (estimateChatTokens(request) / 1e6) * this.options.promptPrice;
    if (this.spent + estimate > this.options.budgetUsd) {
      throw new BudgetExceeded(`budget $${this.options.budgetUsd} would be exceeded (spent $${this.spent.toFixed(3)}, next ~$${estimate.toFixed(3)})`);
    }

    const release = await this.slot();
    try {
      for (let attempt = 0; ; attempt++) {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const raw = await response.text();
        if (!response.ok) {
          if (attempt < 3 && (response.status === 429 || response.status >= 500)) {
            await new Promise(resolve => setTimeout(resolve, 1500 * 2 ** attempt));
            continue;
          }
          throw new Error(`replay request failed (${response.status}): ${raw.slice(0, 300)}`);
        }
        const json = JSON.parse(raw) as {
          choices?: Array<{ finish_reason?: string; message?: { content?: string | null; tool_calls?: Array<{ function: { name: string; arguments: string } }> } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
        };
        const message = json.choices?.[0]?.message;
        const result: ReplayResponse = {
          text: message?.content ?? '',
          toolCalls: (message?.tool_calls ?? []).map(call => ({ name: request.names.get(call.function.name) ?? call.function.name, args: call.function.arguments })),
          promptTokens: json.usage?.prompt_tokens ?? 0,
          completionTokens: json.usage?.completion_tokens ?? 0,
          costUsd: json.usage?.cost ?? 0,
          finishReason: json.choices?.[0]?.finish_reason ?? '',
          cached: false,
        };
        this.spent += result.costUsd;
        this.live += 1;
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(result));
        return result;
      }
    } finally {
      release();
    }
  }
}

export { argText, fullText };

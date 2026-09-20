import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { estimateTokens, type Message, type ToolCall } from '../../src/vendor/fast-jev-compaction/index.js';

/** A result needs at least this many distinct echoed tokens to count as used. */
export const ECHO_MIN = 2;
/** Tokens present in more span results than this are too generic to attribute. */
const MAX_DOCUMENT_FREQUENCY = 3;
const MAX_CHARS_SCANNED = 300_000;
const MAX_TOKENS_PER_TEXT = 5_000;

/** Tools whose repeated call with the same arguments means the output was needed again. */
const RERUN_TOOLS = new Set(['read', 'grep', 'find', 'ls', 'hypa_grep']);
const MUTATING_TOOLS = new Set(['edit', 'write']);

export interface CallLabel {
  id: string;
  tool: string;
  resultTokens: number;
  /** A later call in the span repeats this one, so this output is obsolete. */
  superseded: boolean;
  /**
   * The agent repeats this call after the cut with nothing changed in between.
   * Diagnostic only: an audit of 10 such calls found none were needed from
   * memory. Most re-reads are for fresh edit anchors and would happen anyway.
   */
  rerun: boolean;
  /** Distinctive tokens of the result that the agent later wrote or passed to a tool. */
  echo: number;
  /** The subset of `echo` that appears in no other span result. */
  echoUnique: number;
  /** Those strings themselves, for locating the moment the agent used them. */
  uniqueTokens: string[];
  /**
   * Later use from memory of content only this result holds, so dropping it
   * loses something. Results whose strings are duplicated elsewhere in the span
   * are not marked: keeping any one copy suffices, which the token-level recall
   * already accounts for.
   */
  used: boolean;
  /** The agent later recalled a string that only this call's input carries. */
  callUsed: boolean;
}

export interface CaseLabels {
  calls: Map<string, CallLabel>;
  /** Echoed result tokens the compacted context must still contain to preserve later use. */
  needed: Set<string>;
  /**
   * Strings from call inputs (paths, identifiers) the agent later recalled.
   * Losing them means forgetting a call was made, which is what `drop_call` does.
   */
  neededCall: Set<string>;
}

type Block = { type: string; [key: string]: unknown };

function blocksOf(message: AgentMessage): Block[] {
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? (content as Block[]) : [];
}

function textOfBlocks(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  return blocksOf(message)
    .map(block => (typeof block.text === 'string' ? block.text : ''))
    .join('\n');
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
}

/** All string values of a tool input, newline-joined; `JSON.stringify` would glue escapes like `\\n` onto the next word. */
export function argText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(argText).join('\n');
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).map(argText).join('\n');
  }
  return value === undefined || value === null ? '' : String(value);
}

function pathOf(input: Record<string, unknown>): string | undefined {
  const value = input.path ?? input.file_path;
  return typeof value === 'string' ? value : undefined;
}

/** Identity of a repeatable call; undefined when a repeat says nothing about need. */
function callKey(tool: string, input: Record<string, unknown>): string | undefined {
  if (!RERUN_TOOLS.has(tool)) return undefined;
  if (tool === 'read') {
    const path = pathOf(input);
    return path ? `read:${path}` : undefined;
  }
  return `${tool}:${stable(input)}`;
}

/** Whether a mutation could have changed what this repeatable call returns. */
function invalidates(key: string, mutation: { tool: string; path?: string }): boolean {
  if (!MUTATING_TOOLS.has(mutation.tool)) return false;
  if (key.startsWith('read:')) return mutation.path === key.slice('read:'.length);
  return true;
}

const PATH_LIKE = /[\w@~.-]+(?:\/[\w@~.-]+)+/g;
const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]{6,}/g;
const HEX_ID = /\b[0-9a-f]{7,40}\b/g;

/** Strings specific enough that finding one later means the source was consulted. */
export function distinctiveTokens(text: string): Set<string> {
  const scanned = text.length > MAX_CHARS_SCANNED ? text.slice(0, MAX_CHARS_SCANNED) : text;
  const tokens = new Set<string>();
  const add = (token: string): void => {
    if (tokens.size < MAX_TOKENS_PER_TEXT) tokens.add(token);
  };
  for (const [match] of scanned.matchAll(PATH_LIKE)) {
    if (match.length >= 8 && /[A-Za-z]/.test(match)) add(match);
  }
  for (const [match] of scanned.matchAll(IDENTIFIER)) {
    // Skip plain words: keep snake_case, camelCase, and names with digits.
    if (/[a-z][A-Z]|_|\d/.test(match)) add(match);
  }
  for (const [match] of scanned.matchAll(HEX_ID)) {
    if (/\d/.test(match) && /[a-f]/.test(match)) add(match);
  }
  return tokens;
}

function inputsText(messages: readonly Message[]): string {
  return messages
    .flatMap(message => [message.text, ...message.toolUses.map(tool => argText(tool.input))])
    .join('\n');
}

export function fullText(message: AgentMessage): string {
  if (message.role === 'assistant') {
    return blocksOf(message)
      .map(block => {
        if (block.type === 'text') return String(block.text ?? '');
        if (block.type === 'thinking') return String(block.thinking ?? '');
        if (block.type === 'toolCall') return argText(block.arguments);
        return '';
      })
      .join('\n');
  }
  if (message.role === 'bashExecution') return `${message.command}\n${message.output}`;
  if (message.role === 'compactionSummary' || message.role === 'branchSummary') return message.summary;
  return textOfBlocks(message);
}

/**
 * Distinctive strings the agent produced from memory: said, thought, or passed
 * to a tool before any later user message or tool output had shown them. A
 * string the agent could have copied from something newer says nothing about
 * whether the compacted span had to preserve it.
 */
function recalledTokens(future: readonly AgentMessage[]): Set<string> {
  const observed = new Set<string>();
  const recalled = new Set<string>();
  for (const message of future) {
    const tokens = distinctiveTokens(fullText(message));
    if (message.role === 'assistant') {
      for (const token of tokens) if (!observed.has(token)) recalled.add(token);
    } else {
      for (const token of tokens) observed.add(token);
    }
  }
  return recalled;
}

/**
 * The first future message where the agent produced any of `tokens` from
 * memory (same rule as `recalledTokens`), with the strings it produced there.
 */
export function firstRecall(
  future: readonly AgentMessage[],
  tokens: ReadonlySet<string>,
): { index: number; tokens: string[] } | undefined {
  const observed = new Set<string>();
  for (let index = 0; index < future.length; index++) {
    const message = future[index]!;
    const found = distinctiveTokens(fullText(message));
    if (message.role === 'assistant') {
      const hits = [...found].filter(token => tokens.has(token) && !observed.has(token));
      if (hits.length > 0) return { index, tokens: hits };
    } else {
      for (const token of found) observed.add(token);
    }
  }
  return undefined;
}

interface Step {
  tool: string;
  input: Record<string, unknown>;
}

function futureSteps(future: readonly AgentMessage[]): Step[] {
  const steps: Step[] = [];
  for (const message of future) {
    if (message.role !== 'assistant') continue;
    for (const block of blocksOf(message)) {
      if (block.type !== 'toolCall') continue;
      steps.push({
        tool: String(block.name),
        input: (block.arguments as Record<string, unknown>) ?? {},
      });
    }
  }
  return steps;
}

/**
 * Derives, from what the agent really did after the cut, which span results
 * turned out to matter. Two signals, both computed without a judge model:
 *
 * - `rerun`: the agent repeats an idempotent read-style call with identical
 *   arguments and nothing has edited the target since. It needed that output
 *   again, so any policy that dropped it forced a re-fetch.
 * - `echo`: distinctive strings (paths, identifiers, ids) from the result show
 *   up in the agent's later text, thinking, or tool arguments before anything
 *   newer showed them (see `recalledTokens`). Strings already present in kept
 *   material (span text, span call inputs, pi's kept tail) are excluded
 *   because no policy can lose them.
 *
 * Both are lower bounds on need: information used without being repeated
 * verbatim is invisible here.
 */
export function labelCase(
  converted: readonly Message[],
  calls: readonly ToolCall[],
  tail: readonly AgentMessage[],
  future: readonly AgentMessage[],
): CaseLabels {
  const resultText = new Map<string, string>();
  for (const message of converted) {
    for (const result of message.toolResults ?? []) resultText.set(result.tool_use_id, result.text);
  }

  const spanMutations = converted.flatMap((message, index) =>
    message.toolUses
      .filter(tool => MUTATING_TOOLS.has(tool.tool))
      .map(tool => ({ index, tool: tool.tool, path: pathOf(tool.input) })),
  );
  const steps = futureSteps(future);

  const tailTokens = distinctiveTokens(tail.map(fullText).join('\n'));
  const safe = new Set([...distinctiveTokens(inputsText(converted)), ...tailTokens]);
  const evidence = recalledTokens(future);

  const neededCall = new Set<string>();
  for (const call of calls) {
    for (const token of distinctiveTokens(argText(call.input))) {
      if (evidence.has(token) && !tailTokens.has(token)) neededCall.add(token);
    }
  }

  const tokensByCall = new Map<string, Set<string>>();
  const frequency = new Map<string, number>();
  for (const call of calls) {
    const tokens = new Set<string>();
    for (const token of distinctiveTokens(resultText.get(call.tool_use_id) ?? '')) {
      if (!safe.has(token)) tokens.add(token);
    }
    tokensByCall.set(call.id, tokens);
    for (const token of tokens) frequency.set(token, (frequency.get(token) ?? 0) + 1);
  }

  const keys = calls.map(call => callKey(call.tool, call.input));
  const labelled = new Map<string, CallLabel>();
  const needed = new Set<string>();

  calls.forEach((call, position) => {
    const key = keys[position];
    const superseded =
      key !== undefined &&
      calls.some((other, otherPosition) => otherPosition > position && keys[otherPosition] === key);

    let rerun = false;
    if (key !== undefined && !superseded) {
      const mutatedInSpan = spanMutations.some(
        mutation => mutation.index > call.callIndex && invalidates(key, mutation),
      );
      if (!mutatedInSpan) {
        for (const step of steps) {
          if (invalidates(key, { tool: step.tool, path: pathOf(step.input) })) break;
          if (callKey(step.tool, step.input) === key) {
            rerun = true;
            break;
          }
        }
      }
    }

    const echoed = [...(tokensByCall.get(call.id) ?? [])].filter(
      token => (frequency.get(token) ?? 0) <= MAX_DOCUMENT_FREQUENCY && evidence.has(token),
    );
    const unique = echoed.filter(token => frequency.get(token) === 1);
    const used = unique.length >= ECHO_MIN;
    if (echoed.length >= ECHO_MIN) for (const token of echoed) needed.add(token);

    labelled.set(call.id, {
      id: call.id,
      tool: call.tool,
      resultTokens: estimateTokens(resultText.get(call.tool_use_id) ?? ''),
      superseded,
      rerun,
      echo: echoed.length,
      echoUnique: unique.length,
      uniqueTokens: unique,
      used,
      callUsed: [...distinctiveTokens(argText(call.input))].some(token => neededCall.has(token)),
    });
  });

  return { calls: labelled, needed, neededCall };
}
